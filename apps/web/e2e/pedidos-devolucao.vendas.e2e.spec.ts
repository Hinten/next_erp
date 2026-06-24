import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import { cleanupPedidoFixtures, e2ePrefix, seedPedidoFixtures } from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * E2E for the Devolução tab — the two legacy return modes write
 * `itensDevolvidos` (a field on the pedido doc), persisted on the main save:
 *  - Mode A: pick a paid ORIGIN order → its items are cloned as return rows.
 *  - Mode B: add an AVULSO item → pick a produto + price/qty.
 * Seeds the current pedido + a paid origin pedido via the Admin SDK.
 */
test.describe.serial('Pedidos e2e — Devolução', () => {
  const prefix = e2ePrefix('peddev');
  const pedidoId = `${prefix}-001`;
  const originId = `${prefix}-orig`;
  const originNumero = `${prefix}-ORIG`;
  let fixtures: Awaited<ReturnType<typeof seedPedidoFixtures>>;
  let produtoId: string;

  function pedidoBody(extra: Record<string, unknown>) {
    return {
      ehSaida: true,
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
      ...extra,
    };
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedPedidoFixtures(prefix);
    produtoId = fixtures.produtoPath.split('/')[1]!;

    // The pedido being edited, and a PAID origin order to return from.
    await db()
      .collection('pedidos')
      .doc(pedidoId)
      .set(pedidoBody({ estado: 'iniciado' }));
    await db()
      .collection('pedidos')
      .doc(originId)
      .set(pedidoBody({ estado: 'pago', numero: originNumero }));

    await warmRoutes(browser, ['/pedidos']);
  });

  // Each test starts from a clean returns map on the edited pedido.
  test.beforeEach(async () => {
    await db()
      .collection('pedidos')
      .doc(pedidoId)
      .update({ itensDevolvidos: null, valorDevolucao: 0 });
  });

  test.afterAll(async () => {
    await db().collection('pedidos').doc(originId).delete();
    await db().collection('pedidos').doc(pedidoId).delete();
    await cleanupPedidoFixtures(prefix);
  });

  test('Mode A — clones a paid origin order and persists itensDevolvidos on save', async ({
    page,
  }) => {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('tab', { name: 'Devolução' }).click();

    // Open the origin picker, search the paid order by número and add it.
    await page.getByRole('button', { name: '+ Adicionar pedido' }).click();
    await page.getByLabel('Buscar por número').fill(originNumero);
    await page.getByRole('button', { name: `Adicionar ${originNumero}` }).click();
    await page.getByRole('button', { name: 'Fechar' }).click();

    // The cloned row appears (qty = origin sold qty 2); reduce it to 1.
    const qty = page.getByLabel(`Quantidade devolvida de ${fixtures.produtoNome}`);
    await expect(qty).toBeVisible({ timeout: 15_000 });
    await qty.fill('1');

    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await page.waitForURL((url) => /\/pedidos$/.test(url.pathname), { timeout: 30_000 });

    await expect
      .poll(
        async () => {
          const data = (await db().collection('pedidos').doc(pedidoId).get()).data();
          const dev = data?.itensDevolvidos as
            | Record<string, Record<string, Array<{ quantidade?: number }>>>
            | null
            | undefined;
          return {
            qty: dev?.[originId]?.[produtoId]?.[0]?.quantidade ?? null,
            valorDevolucao: data?.valorDevolucao ?? null,
          };
        },
        { timeout: 15_000 },
      )
      .toEqual({ qty: 1, valorDevolucao: 10 });
  });

  test('Mode B — adds an avulso produto and persists it under NONE', async ({ page }) => {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('tab', { name: 'Devolução' }).click();

    // Add an avulso row, pick the produto fixture, set price = 10.
    await page.getByRole('button', { name: '+ Produto avulso' }).click();
    await page.getByPlaceholder('Buscar produto avulso…').fill(fixtures.produtoNome);
    await page.getByRole('option', { name: new RegExp(fixtures.produtoNome) }).click();
    await page.getByLabel(`Preço de ${fixtures.produtoNome}`).fill('10');

    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await page.waitForURL((url) => /\/pedidos$/.test(url.pathname), { timeout: 30_000 });

    await expect
      .poll(
        async () => {
          const data = (await db().collection('pedidos').doc(pedidoId).get()).data();
          const dev = data?.itensDevolvidos as
            | Record<string, Record<string, Array<{ quantidade?: number; precoDeVenda?: number }>>>
            | null
            | undefined;
          const item = dev?.NONE?.[produtoId]?.[0];
          return item ? { quantidade: item.quantidade, precoDeVenda: item.precoDeVenda } : null;
        },
        { timeout: 15_000 },
      )
      .toEqual({ quantidade: 1, precoDeVenda: 10 });
  });
});
