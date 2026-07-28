import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import { cleanupPedidoFixtures, e2ePrefix, seedPedidoFixtures } from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * E2E for the Estado/Histórico tab: changing a pedido's `estado` and saving must
 * persist the new state AND append a `historicoEstadoPedido` audit row (the
 * legacy `Pedido.save()` behavior). Seeds a minimal pedido (one item + the
 * required refs) directly via the Admin SDK, then drives the UI.
 */
test.describe.serial('Pedidos e2e — Estado / Histórico', () => {
  const prefix = e2ePrefix('pedest');
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

  test.afterAll(async () => {
    // Remove the history subcollection first, then the fixture sweep by prefix.
    const hist = await db()
      .collection('pedidos')
      .doc(pedidoId)
      .collection('historicoEstadoPedido')
      .get();
    await Promise.all(hist.docs.map((d) => d.ref.delete()));
    await cleanupPedidoFixtures(prefix);
  });

  test('changing estado persists it and appends a history row', async ({ page }) => {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    // Open the Estado/Histórico tab and change the estado to "Pago".
    await page.getByRole('tab', { name: 'Estado/Histórico' }).click();
    await page.getByRole('combobox', { name: 'Estado', exact: true }).click();
    await page.getByRole('option', { name: 'Pago', exact: true }).click();

    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await page.waitForURL((url) => /\/pedidos$/.test(url.pathname), { timeout: 30_000 });

    // The pedido doc now carries the new estado.
    await expect
      .poll(
        async () => {
          const snap = await db().collection('pedidos').doc(pedidoId).get();
          return snap.data()?.estado as string | undefined;
        },
        { timeout: 15_000 },
      )
      .toBe('pago');

    // And a historicoEstadoPedido row records the change. That row is written by
    // the `onPedidoEstadoChanged` Cloud Function (apps/functions) reacting to the
    // pedido write above — no longer by the client — so this assertion requires
    // the function to be DEPLOYED to the staging project. The timeout covers a
    // cold start on top of the trigger's own delivery latency.
    await expect
      .poll(
        async () => {
          const hist = await db()
            .collection('pedidos')
            .doc(pedidoId)
            .collection('historicoEstadoPedido')
            .get();
          return hist.docs.map((d) => d.data().estado as string);
        },
        { timeout: 30_000 },
      )
      .toContain('pago');
  });
});
