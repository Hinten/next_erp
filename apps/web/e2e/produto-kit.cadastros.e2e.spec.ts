import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  e2ePrefix,
  getProdutoData,
  getProdutoIdByNome,
  seedComponenteKit,
} from './_helpers/seed-data';
import { fillField, selectFieldWithSearch } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the Kit tab (4a — parent kit, the doc-field manager).
 * It proves: marking `ehKit`, adding a component via the picker, recomputing the
 * kit cost (`custoDoKit` over a batched read → the `custo` field), and the
 * `componentesKit` map + derived `componentesKitKeys` round-tripping on the
 * produto doc (a normal field — no enabler/subcollection).
 */
test.describe.serial('Produtos kit e2e — Kit (componentesKit doc field)', () => {
  const prefix = e2ePrefix('prod-kit');
  const nome = `${prefix}-kit`;
  let produtoId = '';
  let componenteId = '';
  let componenteNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const comp = await seedComponenteKit(prefix, 10); // custo 10
    componenteId = comp.id;
    componenteNome = comp.nome;
    await warmRoutes(browser, ['/produtos/novo']);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('produtos', prefix);
  });

  test('creates a kit, adds a component, auto-computes cost, persists componentesKit + keys', async ({
    page,
  }) => {
    await page.goto('/produtos/novo');
    await fillField(page, 'Nome', nome);

    await page.getByRole('tab', { name: 'Kit' }).click();
    await page.getByRole('switch', { name: 'É kit', exact: true }).click();

    // Add the seeded component (option name carries the sku hint → match by RegExp).
    await selectFieldWithSearch(
      page,
      'Adicionar componente',
      componenteNome,
      new RegExp(componenteNome),
    );
    await page.getByLabel('Qtd').fill('3');

    // Kit cost is DYNAMIC (no button): component custo 10 × 3 = 30, auto-filled into
    // the read-only Custo field — wait for the computed value shown on the Kit tab.
    await expect(page.getByText(/Custo do kit:\s*R\$\s*30,00/)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Criar', exact: true }).click();

    await expect
      .poll(async () => await getProdutoIdByNome(nome), { timeout: 30_000 })
      .not.toBeNull();
    produtoId = (await getProdutoIdByNome(nome))!;

    const produto = await getProdutoData(produtoId);
    expect(produto?.ehKit).toBe(true);
    expect(produto?.componentesKit).toMatchObject({
      [componenteId]: { quantidade: 3, limitarEstoque: true },
    });
    // The denorm the delete-guard queries mirrors the component ids.
    expect(produto?.componentesKitKeys).toEqual([componenteId]);
    expect(produto?.custo).toBe(30);
  });
});
