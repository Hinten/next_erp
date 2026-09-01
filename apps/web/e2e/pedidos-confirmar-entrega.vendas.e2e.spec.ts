import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import { cleanupPedidoFixtures, e2ePrefix, seedPedidoFixtures } from './_helpers/seed-data';
import {
  applyTextFilter,
  clickAction,
  expectRowVisible,
  selectRowByText,
} from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * E2E for #549 — the `/pedidos` "Confirmar entrega" bulk action.
 *
 * Only what the CLIENT does: mark `freteInicial.estado = entregue`
 * (synthesizing a `semFrete`/sem-transporte block when the pedido has none),
 * move `estado` to `finalizado`, and refuse a pedido outside
 * {emProcessamento, pago}. The resulting `historicoEstadoPedido` /
 * `historicoFtIni` audit rows are written by the server-side
 * `onPedidoChanged` trigger, already covered end-to-end by
 * `pedidos-estado.vendas.e2e.spec.ts` — asserting them again here would
 * assert a deployment fact, not this action's behaviour (CLAUDE.md,
 * `apps/web/CLAUDE.md` rule 8).
 */
test.describe.serial('Pedidos e2e — Confirmar entrega', () => {
  const prefix = e2ePrefix('pedent');
  const pagoId = `${prefix}-pago`;
  const canceladoId = `${prefix}-canc`;
  let fixtures: Awaited<ReturnType<typeof seedPedidoFixtures>>;

  function pedidoBody(extra: Record<string, unknown>) {
    return {
      ehSaida: true,
      integracaoPedidoOuterRef: `documents/${fixtures.integracaoPath}`,
      clientePedidoOuterRef: `documents/${fixtures.clientePath}`,
      operacaoPedidoOuterRef: `documents/${fixtures.operacaoPath}`,
      itens: {},
      itensIds: [],
      descontoTotal: 0,
      valorCobrado: 10,
      timestamp: Date.now() * 1000,
      freteInicial: null,
      ...extra,
    };
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedPedidoFixtures(prefix);

    // A pago pedido with NO freteInicial — the happy path, and the case that
    // must synthesize a semFrete (sem-transporte) block.
    await db()
      .collection('pedidos')
      .doc(pagoId)
      .set(pedidoBody({ estado: 'pago', numero: pagoId }));
    // A cancelado pedido — outside {emProcessamento, pago}, must be refused.
    await db()
      .collection('pedidos')
      .doc(canceladoId)
      .set(pedidoBody({ estado: 'cancelado', numero: canceladoId }));

    await warmRoutes(browser, ['/pedidos']);
  });

  test.afterAll(async () => {
    await cleanupPedidoFixtures(prefix);
  });

  test('confirms delivery for a pago pedido — synthesizes freteInicial and finalizes', async ({
    page,
  }) => {
    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

    await applyTextFilter(page, 'Número', pagoId);
    await expectRowVisible(page, pagoId);
    await selectRowByText(page, pagoId);
    await clickAction(page, 'Confirmar entrega');

    await expect
      .poll(
        async () => {
          const snap = await db().collection('pedidos').doc(pagoId).get();
          return snap.data()?.estado as string | undefined;
        },
        { timeout: 15_000 },
      )
      .toBe('finalizado');

    const snap = await db().collection('pedidos').doc(pagoId).get();
    const frete = snap.data()?.freteInicial as { estado?: string; modalidade?: string } | undefined;
    expect(frete?.estado).toBe('entregue');
    // '9' = MODALIDADE_FRETE.semTransporte — synthesized because the pedido
    // had no freteInicial block.
    expect(frete?.modalidade).toBe('9');
  });

  test('blocks a cancelado pedido with a clear message, without writing', async ({ page }) => {
    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

    await applyTextFilter(page, 'Número', canceladoId);
    await expectRowVisible(page, canceladoId);
    await selectRowByText(page, canceladoId);
    await clickAction(page, 'Confirmar entrega');

    await expect(page.getByText(/Só é possível confirmar a entrega/)).toBeVisible({
      timeout: 15_000,
    });

    const snap = await db().collection('pedidos').doc(canceladoId).get();
    expect(snap.data()?.estado).toBe('cancelado');
  });
});
