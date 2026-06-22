import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import { cleanupPedidoFixtures, e2ePrefix, seedPedidoFixtures } from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * E2E for the Devolução tab: marking a sold item as returned must, on the main
 * pedido save, persist `itensDevolvidos` (a field on the pedido doc) plus the
 * recomputed `valorDevolucao` cache. Seeds a minimal pedido (one item, qty 2)
 * via the Admin SDK, then drives the UI.
 */
test.describe.serial('Pedidos e2e — Devolução', () => {
  const prefix = e2ePrefix('peddev');
  const pedidoId = `${prefix}-001`;
  let fixtures: Awaited<ReturnType<typeof seedPedidoFixtures>>;
  let produtoId: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedPedidoFixtures(prefix);
    produtoId = fixtures.produtoPath.split('/')[1]!;

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
              quantidade: 2,
              custo: null,
            },
          ],
        },
        itensIds: [produtoId],
        descontoTotal: 0,
        valorCobrado: 20,
        timestamp: Date.now() * 1000,
      });

    await warmRoutes(browser, ['/pedidos']);
  });

  test.afterAll(async () => {
    await cleanupPedidoFixtures(prefix);
  });

  test('returns one unit and persists itensDevolvidos + valorDevolucao on save', async ({
    page,
  }) => {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    // Open the Devolução tab and return 1 of the 2 sold units.
    await page.getByRole('tab', { name: 'Devolução' }).click();
    await page.getByLabel(`Quantidade devolvida de ${fixtures.produtoNome}`).fill('1');

    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await page.waitForURL((url) => /\/pedidos$/.test(url.pathname), { timeout: 30_000 });

    // The pedido doc carries the returned item (qty 1) and the recomputed cache.
    await expect
      .poll(
        async () => {
          const data = (await db().collection('pedidos').doc(pedidoId).get()).data();
          const dev = data?.itensDevolvidos as
            | Record<string, Record<string, Array<{ quantidade?: number }>>>
            | null
            | undefined;
          const returnedQty = dev?.[pedidoId]?.[produtoId]?.[0]?.quantidade ?? null;
          return { returnedQty, valorDevolucao: data?.valorDevolucao ?? null };
        },
        { timeout: 15_000 },
      )
      .toEqual({ returnedQty: 1, valorDevolucao: 10 });
  });
});
