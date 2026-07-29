import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import {
  cleanupPedidoFixtures,
  cleanupPedidoSubcollection,
  e2ePrefix,
  seedPedidoFixtures,
} from './_helpers/seed-data';
import { typeMoney } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * E2E for the editable Pagamento tab: adding a pagamento writes a doc to the
 * `pedidos/{id}/pagamentos` subcollection (immediate write via the use-case, no
 * main-form save). Seeds a minimal pedido via the Admin SDK, then drives the UI.
 */
test.describe.serial('Pedidos e2e — Pagamento', () => {
  const prefix = e2ePrefix('pedpag');
  const pedidoId = `${prefix}-001`;
  let fixtures: Awaited<ReturnType<typeof seedPedidoFixtures>>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedPedidoFixtures(prefix);
    const produtoId = fixtures.produtoPath.split('/')[1]!;

    await db()
      .collection('pedidos')
      .doc(pedidoId)
      .set({
        ehSaida: true,
        estado: 'iniciado',
        numero: pedidoId,
        integracaoPedidoOuterRef: `documents/${fixtures.integracaoPath}`,
        clientePedidoOuterRef: `documents/${fixtures.clientePath}`,
        operacaoPedidoOuterRef: `documents/${fixtures.operacaoPath}`,
        itens: {
          [produtoId]: [
            {
              produtoUid: produtoId,
              ordem: 1,
              sku: fixtures.produtoSku,
              nomeDeVenda: fixtures.produtoNome,
              precoDeVenda: 10,
              descontoUnitario: 0,
              quantidade: 1,
              custo: null,
            },
          ],
        },
        itensIds: [produtoId],
        descontoTotal: 0,
        valorCobrado: 10,
        timestamp: Date.now() * 1000,
      });

    await warmRoutes(browser, ['/pedidos']);
  });

  // Reset estado + clear the pagamentos/history subcollections before each
  // attempt, so every test starts from `iniciado` with no leftover pagamentos
  // or history. Estado FIRST, then the deletes — the trigger reacts to the reset
  // write, so sweeping before it would leave the row it appends behind.
  test.beforeEach(async () => {
    await db().collection('pedidos').doc(pedidoId).update({ estado: 'iniciado' });
    await cleanupPedidoSubcollection(pedidoId, 'pagamentos');
    await cleanupPedidoSubcollection(pedidoId, 'historicoEstadoPedido');
    await cleanupPedidoSubcollection(pedidoId, 'historicoFtIni');
  });

  // `cleanupPedidoFixtures` deletes the pedido doc with a plain batch delete, which
  // does NOT cascade subcollections — so all three must be swept here. The estado
  // auto-transition test now runs LAST (it is the deploy gate), so this is the only
  // thing standing between a failed staging run and orphaned audit rows under a
  // parent that no longer exists. `historicoFtIni` is the frete-estado trail the
  // same trigger owns: this fixture has no `freteInicial` block, so it produces no
  // rows today — the sweep is here so it stays true if the seed ever gains one.
  test.afterAll(async () => {
    await cleanupPedidoSubcollection(pedidoId, 'pagamentos');
    await cleanupPedidoSubcollection(pedidoId, 'historicoEstadoPedido');
    await cleanupPedidoSubcollection(pedidoId, 'historicoFtIni');
    await cleanupPedidoFixtures(prefix);
  });

  test('adds a pagamento and persists it to the subcollection', async ({ page }) => {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('tab', { name: 'Pagamento' }).click();
    await page.getByRole('button', { name: /Adicionar pagamento/ }).click();
    // forma defaults to "Dinheiro"; set the valor and add. Drive the masked
    // CurrencyInput via the shared `typeMoney` helper (the documented path).
    await typeMoney(page, 'Valor', '100');
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click();

    // The list shows the new row (formatted value in a table cell, not the form input).
    await expect(page.getByRole('cell', { name: 'R$ 100,00' })).toBeVisible({ timeout: 15_000 });

    // The subcollection has the doc (forma 1 = Dinheiro, valor 100).
    await expect
      .poll(
        async () => {
          const snap = await db()
            .collection('pedidos')
            .doc(pedidoId)
            .collection('pagamentos')
            .get();
          const p = snap.docs.map((d) => d.data())[0];
          return p ? { forma: p.forma_de_pagamento, valor: p.valor } : null;
        },
        { timeout: 15_000 },
      )
      .toEqual({ forma: 1, valor: 100 });
  });

  test('shows forma-specific fields and autofills the remaining valor', async ({ page }) => {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('tab', { name: 'Pagamento' }).click();
    await page.getByRole('button', { name: /Adicionar pagamento/ }).click();

    // Dinheiro (default) hides Parcelas + the card group; Cartão de Crédito shows them.
    await expect(page.getByLabel('Parcelas')).toHaveCount(0);
    await expect(page.getByLabel('Bandeira')).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Forma de pagamento' }).click();
    await page.getByRole('option', { name: 'Cartão de Crédito', exact: true }).click();
    await expect(page.getByLabel('Parcelas')).toBeVisible();

    // The card-detail group is now shown — pick a bandeira (Visa = '01').
    await page.getByRole('combobox', { name: 'Bandeira' }).click();
    await page.getByRole('option', { name: 'Visa', exact: true }).click();

    // Autofill the remaining valor (pedido total R$ 10,00, no other payments).
    await page.getByRole('button', { name: 'Preencher com o valor restante' }).click();
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click();

    // Persisted as Cartão de Crédito (forma 3) for the full remaining amount, with
    // the bandeira recorded on the embedded card map.
    await expect
      .poll(
        async () => {
          const snap = await db()
            .collection('pedidos')
            .doc(pedidoId)
            .collection('pagamentos')
            .get();
          const p = snap.docs.map((d) => d.data())[0];
          return p
            ? { forma: p.forma_de_pagamento, valor: p.valor, bandeira: p.cartao?.bandeira ?? null }
            : null;
        },
        { timeout: 15_000 },
      )
      .toEqual({ forma: 3, valor: 10, bandeira: '01' });
  });

  test('locks dados gerais / itens / frete / devolução once the pedido leaves the cart phase (estado "pago") — but keeps observações editable', async ({
    page,
  }) => {
    // beforeEach reset estado to "iniciado"; move it to "pago" so the edit lock
    // (legacy `travar_inclusao_produto` / `travar_pedido`) engages.
    await db().collection('pedidos').doc(pedidoId).update({ estado: 'pago' });

    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    // Principal: the lock notice shows and item editing is disabled…
    await expect(page.getByText(/Edição bloqueada/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Adicionar produto' })).toBeDisabled();
    // …but "Observações internas" stays editable (legacy leaves it unlocked).
    await expect(page.getByLabel('Observações internas')).toBeEnabled();

    // Footer: the editable "Desconto" follows the estado lock (legacy
    // `pedidoCadastro.dart:1719`), while the Salvar button stays enabled.
    await expect(page.getByLabel('Desconto total')).toBeDisabled();

    // Frete tab: the whole tab locks (legacy passes `travarPedido` to the widget).
    await page.getByRole('tab', { name: 'Frete' }).click();
    await expect(page.getByRole('tabpanel').getByText(/Edição bloqueada/)).toBeVisible();

    // Devolução tab: a return is a NEW order returning this one, so the original's
    // rows lock once it leaves the cart phase (legacy `!travar_pedido`).
    await page.getByRole('tab', { name: 'Devolução' }).click();
    await expect(page.getByRole('tabpanel').getByText(/Edição bloqueada/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Adicionar pedido/ })).toBeDisabled();
  });

  test('warns (without blocking) when adding a payment to an already-paid pedido', async ({
    page,
  }) => {
    // "pago" but no approved NF-e → the legacy save guard does NOT lock payments,
    // so adding stays enabled; we only surface a soft warning.
    await db().collection('pedidos').doc(pedidoId).update({ estado: 'pago' });

    await page.goto(`/pedidos/${pedidoId}/editar`);
    await page.getByRole('tab', { name: 'Pagamento' }).click();

    const addBtn = page.getByRole('button', { name: /Adicionar pagamento/ });
    await expect(addBtn).toBeEnabled();
    await addBtn.click();

    // The "Novo pagamento" form shows the unexpected-payment warning, but the
    // "Adicionar" confirm button stays enabled (non-blocking).
    await expect(page.getByText(/novo\s+pagamento é incomum/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Adicionar', exact: true })).toBeEnabled();
  });

  // DEPLOY GATE — keep this LAST in the serial describe. Since #308 the estado
  // reconcile is server-owned (the `reconciliarPagamentoPedido` callable), and
  // this is the ONLY check here that catches "the callable was never deployed":
  // the other tests above also pay the pedido in full, but assert nothing beyond
  // the pagamento doc, which the client writes on its own. The server path
  // itself is covered offline by `pedidos-pagamento-reconcile.emulator.e2e.spec.ts`;
  // against staging this stays red until the deploy lands, and running last
  // means one red test instead of aborting the ones that would follow it.
  test('fully paying a pedido auto-transitions it to "pago" and logs the history', async ({
    page,
  }) => {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('tab', { name: 'Pagamento' }).click();
    await page.getByRole('button', { name: /Adicionar pagamento/ }).click();
    // Pedido total is R$ 10,00; pay it in full (default forma Dinheiro, default
    // status Aprovado → counts toward "paid").
    await typeMoney(page, 'Valor', '10');
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'R$ 10,00' })).toBeVisible({ timeout: 15_000 });

    // The auto-reconcile flips the pedido estado to "pago"…
    await expect
      .poll(
        async () => {
          const snap = await db().collection('pedidos').doc(pedidoId).get();
          return (snap.data()?.estado as string | undefined) ?? null;
        },
        { timeout: 15_000 },
      )
      .toBe('pago');

    // …and a historicoEstadoPedido row records it. That row is written by the
    // `onPedidoEstadoChanged` Cloud Function (apps/functions) reacting to the
    // pedido write — no longer by the client — so this assertion requires the
    // function to be DEPLOYED to the staging project. The timeout covers a cold
    // start on top of the trigger's own delivery latency.
    await expect
      .poll(
        async () => {
          const snap = await db()
            .collection('pedidos')
            .doc(pedidoId)
            .collection('historicoEstadoPedido')
            .get();
          return snap.docs.map((d) => d.data().estado as string);
        },
        { timeout: 30_000 },
      )
      .toContain('pago');
  });
});
