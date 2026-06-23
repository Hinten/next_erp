import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import { cleanupPedidoFixtures, e2ePrefix, seedPedidoFixtures } from './_helpers/seed-data';
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

  // Clear the subcollection before each attempt so a retry starts clean.
  test.beforeEach(async () => {
    const pg = await db().collection('pedidos').doc(pedidoId).collection('pagamentos').get();
    await Promise.all(pg.docs.map((d) => d.ref.delete()));
  });

  test.afterAll(async () => {
    const pg = await db().collection('pedidos').doc(pedidoId).collection('pagamentos').get();
    await Promise.all(pg.docs.map((d) => d.ref.delete()));
    await cleanupPedidoFixtures(prefix);
  });

  test('adds a pagamento and persists it to the subcollection', async ({ page }) => {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('tab', { name: 'Pagamento' }).click();
    await page.getByRole('button', { name: /Adicionar pagamento/ }).click();
    // forma defaults to "Dinheiro"; set the valor and save.
    await page.getByLabel('Valor').fill('100');
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();

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
});
