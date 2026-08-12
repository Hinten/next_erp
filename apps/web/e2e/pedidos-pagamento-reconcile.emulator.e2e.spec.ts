import { expect, test, type Locator, type Page } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import { cleanupPedidoFixtures, e2ePrefix, seedPedidoFixtures } from './_helpers/seed-data';
import { typeMoney } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * Server-owned pedido `estado` auto-reconcile (#308). The reconcile no longer
 * runs in the browser: `PagamentosSection`'s `reconcileEstado()` calls the
 * `reconciliarPagamentoPedido` onCall, which delegates to the Admin-SDK
 * `reconcilePedidoEstado` — the pedido AND every pagamento read in ONE
 * transaction. That is the atomic snapshot the Firebase JS client SDK cannot
 * take (it can't read a query inside `runTransaction`, so the old client path
 * summed the payments with a `getDocs` BEFORE the tx and two concurrent
 * reconciles could settle on a stale estado). The cutover is HARD — there is no
 * client-side fallback left, so these assertions fail if the callable is broken.
 *
 * Emulator-only (`e2e-emulator.yml`): `firebase.e2e.json` serves the whole
 * `storage` functions codebase FROM SOURCE on :5001, so the real callable runs
 * locally and no staging deploy is needed — exactly what
 * `produto-estoque.emulator.e2e.spec.ts` does for `aplicarEstoque`. One test per
 * `reconcileEstado()` call site in `PagamentosSection.tsx`: `handleSave`,
 * `PagamentoRow.handleStatusChange` and `handleDelete`.
 *
 * ⚠️ In the emulator, Admin SDK seed writes ALSO fire the pedido triggers, so
 * the fixture pedido is seeded at `estado: 'iniciado'` with ZERO pagamentos (a
 * no-effect estado, which doubles as the trigger warm-up), and `beforeEach`
 * resets the estado BEFORE deleting the pagamento/history docs — the order the
 * staging sibling `pedidos-pagamento.vendas.e2e.spec.ts` already uses — so
 * nothing settles mid-arrange.
 */
test.describe.serial('Pedidos e2e — reconcile de estado no servidor', () => {
  const prefix = e2ePrefix('ped-reconcile');
  const pedidoId = `${prefix}-001`;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const fixtures = await seedPedidoFixtures(prefix);
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

    await warmRoutes(browser, [`/pedidos/${pedidoId}/editar`]);
  });

  test.beforeEach(async () => {
    // A cold functions emulator pays the callable's first-invocation cost on the
    // assertion clock; `setTimeout` from a hook applies to the running test.
    test.setTimeout(300_000);
    // Reset estado FIRST, then drop the subcollections (the order the staging
    // sibling uses): every test starts from `iniciado` with no leftover
    // pagamentos or history.
    await db().collection('pedidos').doc(pedidoId).update({ estado: 'iniciado' });
    await limparSubcolecoes();
  });

  test.afterAll(async () => {
    await limparSubcolecoes();
    await cleanupPedidoFixtures(prefix);
  });

  /**
   * Drop every pagamento + estado-history + frete-history row of the fixture
   * pedido. `historicoFtIni` is the freight trail `onPedidoEstadoChanged` also
   * owns; this fixture seeds no `freteInicial`, so it stays empty today — the
   * sweep is here so it stays true if that ever changes. Two hazards it implies:
   *
   * (a) this runs immediately after the `beforeEach` estado reset, and the
   *     trigger writes ASYNCHRONOUSLY — the row for that reset can land after
   *     the delete has already passed over the collection. Any assertion on
   *     either trail must therefore be `toContain`-shaped or scoped to a known
   *     `eventId`; a bare `toHaveLength(n)` will be intermittently red.
   * (b) if this fixture ever gains a `freteInicial`, reset `freteInicial.estado`
   *     in the SAME `update()` call as `estado`. Two separate updates fire two
   *     CloudEvents, and the second one's row is written after the sweep — the
   *     exact race (a) describes, made permanent.
   */
  async function limparSubcolecoes(): Promise<void> {
    const pedidoRef = db().collection('pedidos').doc(pedidoId);
    const [pagamentos, historico, historicoFrete] = await Promise.all([
      pedidoRef.collection('pagamentos').get(),
      pedidoRef.collection('historicoEstadoPedido').get(),
      pedidoRef.collection('historicoFtIni').get(),
    ]);
    await Promise.all(
      [...pagamentos.docs, ...historico.docs, ...historicoFrete.docs].map((d) => d.ref.delete()),
    );
  }

  /** The pedido's stored `estado` — the reconcile is server-owned, so the doc
   *  (Admin SDK, rules-free) is the source of truth here, never the UI. */
  async function getEstado(): Promise<string | null> {
    const snap = await db().collection('pedidos').doc(pedidoId).get();
    return (snap.data()?.estado as string | undefined) ?? null;
  }

  /** Every `historicoEstadoPedido` row's `estado` — the trail the
   *  `onPedidoEstadoChanged` trigger appends ASYNCHRONOUSLY, one row per
   *  transition PLUS an opening row for the estado the pedido was created or
   *  reset with. Never count the whole trail; look for the estado you expect. */
  async function getHistoricoEstados(): Promise<string[]> {
    const snap = await db()
      .collection('pedidos')
      .doc(pedidoId)
      .collection('historicoEstadoPedido')
      .get();
    return snap.docs.map((d) => d.data().estado as string);
  }

  /** The single pagamento row in the tab's table. Located by its row actions
   *  rather than the formatted value, so it survives a valor change. */
  function linhaPagamento(page: Page): Locator {
    return page.getByRole('row').filter({
      has: page.getByRole('button', { name: 'Excluir', exact: true }),
    });
  }

  async function abrirAbaPagamento(page: Page): Promise<void> {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('tab', { name: 'Pagamento' }).click();
  }

  async function adicionarPagamento(page: Page, valor: string): Promise<void> {
    await page.getByRole('button', { name: /Adicionar pagamento/ }).click();
    // forma defaults to "Dinheiro" and status to "Aprovado" — the only status
    // besides null that counts toward the paid total (`isPagamentoPagante`).
    await typeMoney(page, 'Valor', valor);
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await expect(linhaPagamento(page)).toBeVisible({ timeout: 30_000 });
  }

  test('handleSave: paying the pedido in full settles it as "pago" on the server', async ({
    page,
  }) => {
    await abrirAbaPagamento(page);
    // Pedido total is R$ 10,00 — pay it in full.
    await adicionarPagamento(page, '10');

    // The callable summed the payments against `valorCobrado` inside its own
    // transaction and wrote the estado…
    await expect.poll(getEstado, { timeout: 30_000 }).toBe('pago');
    // …and a historicoEstadoPedido row follows, written ASYNCHRONOUSLY by the
    // `onPedidoEstadoChanged` trigger observing that pedido write — NOT by the
    // reconcile, and not in its transaction (#697). Hence the poll.
    await expect.poll(getHistoricoEstados, { timeout: 30_000 }).toContain('pago');
  });

  test('handleStatusChange: refusing the only payment downgrades the estado', async ({ page }) => {
    await abrirAbaPagamento(page);
    await adicionarPagamento(page, '10');
    await expect.poll(getEstado, { timeout: 30_000 }).toBe('pago');

    // "Recusado" (STATUS_PAGAMENTO_LABELS[6]) is not a paying status — the sum
    // drops to 0, so a `pago` pedido is downgraded back to awaiting payment.
    await linhaPagamento(page).getByRole('combobox').click();
    await page.getByRole('option', { name: 'Recusado', exact: true }).click();

    await expect.poll(getEstado, { timeout: 30_000 }).toBe('aguardandoConfirmacaoDePagamento');
  });

  test('handleDelete: deleting the only payment downgrades the estado', async ({ page }) => {
    await abrirAbaPagamento(page);
    await adicionarPagamento(page, '10');
    await expect.poll(getEstado, { timeout: 30_000 }).toBe('pago');

    await linhaPagamento(page).getByRole('button', { name: 'Excluir', exact: true }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByText('Excluir pagamento')).toBeVisible();
    await modal.getByRole('button', { name: 'Excluir', exact: true }).click();
    await expect(linhaPagamento(page)).toHaveCount(0, { timeout: 30_000 });

    await expect.poll(getEstado, { timeout: 30_000 }).toBe('aguardandoConfirmacaoDePagamento');
  });
});
