import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import {
  cleanupByNamePrefix,
  cleanupPedidoFixtures,
  cleanupPedidoSubcollection,
  e2ePrefix,
  seedPedidoFixtures,
} from './_helpers/seed-data';
import { selectFieldWithSearch, typeMoney } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * E2E for the editable Pagamento tab: adding a pagamento writes a doc to the
 * `pedidos/{id}/pagamentos` subcollection (immediate write via the use-case, no
 * main-form save). Seeds a minimal pedido via the Admin SDK, then drives the UI.
 */
test.describe.serial('Pedidos e2e — Pagamento', () => {
  const prefix = e2ePrefix('pedpag');
  const pedidoId = `${prefix}-001`;
  // A `bandeirasCartao` catalog entry for the "shows forma-specific fields" test
  // (#260) — the bandeira picker is a `CollectionSelect` over this collection, no
  // longer a raw enum `Select`, so it needs a real doc to pick.
  const bandeiraCartaoNome = `${prefix}-visa`;
  let fixtures: Awaited<ReturnType<typeof seedPedidoFixtures>>;
  /**
   * SERVER-clock watermark for this attempt, in microseconds. Rows older than
   * this belong to a previous attempt (or to an earlier test in this serial
   * describe). See `beforeEach` for why it cannot come from `Date.now()`.
   */
  let attemptStartMicros: number;

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

    await db().collection('bandeirasCartao').doc(bandeiraCartaoNome).set({
      ehCredito: true,
      nome: bandeiraCartaoNome,
      cnpj_instituicao: '12345678000199',
      bandeira: '01',
      tarifa: 2.5,
      tarifaFixa: 0.3,
      maxParcelas: 6,
      prazoRecebimento: 30,
      dataCadastro: Date.now(),
      ultimaModificacao: Date.now(),
    });

    await warmRoutes(browser, ['/pedidos']);
  });

  // Clear the pagamentos/history subcollections, THEN reset estado, so every
  // attempt starts from `iniciado` with no leftover pagamentos or history. The
  // reset is last because the trigger reacts to it: sweeping afterwards would
  // race the row it appends, and the watermark below is what makes that row
  // attributable to this attempt instead.
  test.beforeEach(async () => {
    const pg = await db().collection('pedidos').doc(pedidoId).collection('pagamentos').get();
    await Promise.all(pg.docs.map((d) => d.ref.delete()));
    const hist = await db()
      .collection('pedidos')
      .doc(pedidoId)
      .collection('historicoEstadoPedido')
      .get();
    await Promise.all(hist.docs.map((d) => d.ref.delete()));
    // The same trigger owns the frete-estado trail. This fixture seeds no
    // `freteInicial`, so it produces no rows today — swept so that stays true
    // if the seed ever gains one.
    const freteHist = await db()
      .collection('pedidos')
      .doc(pedidoId)
      .collection('historicoFtIni')
      .get();
    await Promise.all(freteHist.docs.map((d) => d.ref.delete()));

    // Reset LAST, and take this attempt's watermark from the reset's commit
    // timestamp. It must NOT come from `Date.now()`: the trail's `data` is
    // `Date.parse(event.time)` — the CloudEvent occurrence time, i.e. Google's
    // clock — so comparing it against the runner's clock compares two domains,
    // and a runner running ahead would filter out the very row this test waits
    // for. `WriteResult.writeTime` is Firestore's own commit timestamp, the same
    // clock the event time derives from.
    //
    // Deriving it instead from the newest `data` already in the trail does NOT
    // work: the sweep above usually empties it, leaving no value to read, and a
    // stale row arriving after the sweep would then pass any lower bound.
    const { writeTime } = await db()
      .collection('pedidos')
      .doc(pedidoId)
      .update({ estado: 'iniciado' });
    attemptStartMicros = writeTime.toMillis() * 1000;
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
    await cleanupByNamePrefix('bandeirasCartao', prefix);
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

  test('shows forma-specific fields, autofills the remaining valor, and the bandeira catalog pick fills + clamps', async ({
    page,
  }) => {
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

    // Set parcelas above the fixture's maxParcelas (6) — the bandeira pick below
    // must clamp it back down (#260's "new correctness improvement", not a
    // literal legacy port).
    await page.getByLabel('Parcelas').fill('12');

    // The card-detail group is now shown — pick the seeded bandeira catalog entry
    // (#260: a CollectionSelect over `bandeirasCartao`, not a raw enum Select).
    await selectFieldWithSearch(page, 'Bandeira', bandeiraCartaoNome);

    // The pick auto-fills the catalog fields and clamps parcelas to maxParcelas.
    await expect(page.getByLabel('Parcelas')).toHaveValue('6', { timeout: 15_000 });
    await expect(page.getByText(/Preenche tarifa/)).toBeVisible();

    // Autofill the remaining valor (pedido total R$ 10,00, no other payments).
    await page.getByRole('button', { name: 'Preencher com o valor restante' }).click();
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click();

    // Persisted as Cartão de Crédito (forma 3) for the full remaining amount, with
    // the picked catalog's bandeira + tarifa/prazo/CNPJ on the embedded card map,
    // and the top-level parcelas clamped.
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
            ? {
                forma: p.forma_de_pagamento,
                valor: p.valor,
                parcelas: p.parcelas,
                bandeira: p.cartao?.bandeira ?? null,
                tarifa: p.cartao?.tarifa ?? null,
                prazoRecebimento: p.cartao?.prazoRecebimento ?? null,
              }
            : null;
        },
        { timeout: 15_000 },
      )
      .toEqual({
        forma: 3,
        valor: 10,
        parcelas: 6,
        bandeira: '01',
        tarifa: 2.5,
        prazoRecebimento: 30,
      });
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

  test('splits an added cheque payment with parcelas > 1 into one pagamento per installment (#260)', async ({
    page,
  }) => {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('tab', { name: 'Pagamento' }).click();
    await page.getByRole('button', { name: /Adicionar pagamento/ }).click();

    await page.getByRole('combobox', { name: 'Forma de pagamento' }).click();
    await page.getByRole('option', { name: 'Cheque', exact: true }).click();

    await typeMoney(page, 'Valor', '300');
    await page.getByLabel('Parcelas').fill('3');

    // The split controls only render once parcelas > 1 (legacy `_adicionarCheques`).
    await page.getByRole('combobox', { name: 'Intervalo entre os cheques' }).click();
    await page.getByRole('option', { name: 'Dias', exact: true }).click();
    await page.getByLabel('A cada quantos dias').fill('10');
    await page.getByLabel('Banco').fill('BB');

    await page.getByRole('button', { name: 'Adicionar', exact: true }).click();

    // Three rows land in the list — one pagamento per installment, not one
    // multi-parcela doc.
    await expect(page.getByRole('cell', { name: 'R$ 100,00' })).toHaveCount(3, {
      timeout: 15_000,
    });

    const DAY_US = 24 * 60 * 60 * 1_000_000;
    await expect
      .poll(
        async () => {
          const snap = await db()
            .collection('pedidos')
            .doc(pedidoId)
            .collection('pagamentos')
            .get();
          return snap.docs
            .map((d) => {
              const p = d.data();
              return {
                forma: p.forma_de_pagamento as number,
                valor: p.valor as number,
                parcelas: p.parcelas as number,
                aVista: p.aVista as boolean,
                status: p.status_pagamento as number,
                banco: (p.cheque as { banco?: string })?.banco ?? null,
                bomPara: (p.cheque as { bomPara?: number })?.bomPara ?? null,
              };
            })
            .sort((a, b) => (a.bomPara ?? 0) - (b.bomPara ?? 0));
        },
        { timeout: 15_000 },
      )
      .toEqual([
        { forma: 2, valor: 100, parcelas: 1, aVista: false, status: 4, banco: 'BB', bomPara: 0 },
        {
          forma: 2,
          valor: 100,
          parcelas: 1,
          aVista: false,
          status: 4,
          banco: 'BB',
          bomPara: DAY_US * 10,
        },
        {
          forma: 2,
          valor: 100,
          parcelas: 1,
          aVista: false,
          status: 4,
          banco: 'BB',
          bomPara: DAY_US * 20,
        },
      ]);
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
    // The 240s in `beforeAll` extends THAT HOOK, not this test — Playwright's
    // `test.setTimeout` inside a beforeAll sets the hook's own budget. Without
    // this line the body runs on `playwright.config.ts`'s 60s, which the history
    // poll below cannot fit behind the three earlier waits plus the staging
    // `beforeEach`. The symptom would be `Test timeout of 60000ms exceeded`
    // rather than the assertion failing — which would defeat the whole point of
    // the deploy gate, since a slow trigger and an undeployed one would report
    // identically.
    test.setTimeout(180_000);

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
    // start on top of the trigger's own delivery latency, and matches the budget
    // the emulator suite gives the same trigger; staging is strictly slower.
    //
    // Scoped to this attempt's watermark deliberately. Two stale-row leaks would
    // otherwise satisfy a bare `.toContain('pago')`: the preceding test's
    // `update({ estado: 'pago' })` now fires the trigger and nobody waits for
    // it, so its row can land after this test's `beforeEach` snapshot-swept the
    // trail; and across CI's 2 retries `pedidoId` is identical, so a timed-out
    // attempt's row can outlive it. Both carry a `data` from before the reset.
    await expect
      .poll(
        async () => {
          const snap = await db()
            .collection('pedidos')
            .doc(pedidoId)
            .collection('historicoEstadoPedido')
            .get();
          return snap.docs
            .map((d) => d.data())
            .filter((r) => r.estado === 'pago' && (r.data as number) > attemptStartMicros).length;
        },
        { timeout: 90_000 },
      )
      .toBeGreaterThan(0);
  });
});
