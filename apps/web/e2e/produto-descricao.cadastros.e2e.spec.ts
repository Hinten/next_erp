import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  e2ePrefix,
  getProdutoData,
  getProdutoExtraData,
  seedProdutoComFilho,
} from './_helpers/seed-data';
import { clickSave, fillField, selectField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the Descrição + Google Merchant tab — the first
 * consumer of the ObjectView `transientFields` enabler. It proves that the
 * `extraData` aggregate field is persisted to its singleton subdocument
 * (`produtos/<id>/extraData/singleton`), round-trips into the form, and is kept
 * OFF the produto document (the transient strip). Runs serially — the reload
 * test reads what the first test wrote.
 */
test.describe.serial('Produtos descrição e2e — Descrição + Google Merchant (extraData singleton)', () => {
  const prefix = e2ePrefix('prod-extradata');
  let produtoId = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const [produto] = await Promise.all([
      seedProdutoComFilho(prefix),
      warmRoutes(browser, ['/produtos/__aquecimento__/editar']),
    ]);
    produtoId = produto.parentId;
  });

  test.afterAll(async () => {
    await cleanupProdutoSubcollection(produtoId, 'extraData');
    await cleanupByNamePrefix('produtos', prefix);
  });

  async function openDescricaoTab(page: Page) {
    await page.goto(`/produtos/${produtoId}/editar`);
    await page.getByRole('tab', { name: 'Descrição' }).click();
    await expect(page.getByLabel('Descrição', { exact: true })).toBeVisible({ timeout: 15_000 });
  }

  test('persists the extraData singleton and keeps it off the produto doc', async ({ page }) => {
    await openDescricaoTab(page);
    await fillField(page, 'Descrição', 'Camiseta 100% algodão');
    await fillField(page, 'Marca', 'Delfrance');
    await selectField(page, 'Condição', 'Usado');
    // Google Merchant block.
    await fillField(page, 'Título', 'Camiseta básica');
    await selectField(page, 'Faixa etária', 'Juvenil/Adulto (13 anos ou mais)');
    await clickSave(page, 'Salvar alterações');

    // The singleton round-trips with the exact Flutter wire shape (condicao is
    // the int 2 = usado; the GMD block keeps its snake_case keys).
    await expect
      .poll(async () => (await getProdutoExtraData(produtoId))?.descricao, { timeout: 15_000 })
      .toBe('Camiseta 100% algodão');
    const extra = await getProdutoExtraData(produtoId);
    expect(extra).toMatchObject({ descricao: 'Camiseta 100% algodão', marca: 'Delfrance', condicao: 2 });
    expect(extra!.googleMerchantData).toMatchObject({ title: 'Camiseta básica', age_group: 'adult' });

    // The transient field never leaked onto the produto document.
    const produto = await getProdutoData(produtoId);
    expect(produto).not.toHaveProperty('extraData');
    expect(produto).not.toHaveProperty('descricao');
  });

  test('round-trips the saved values back into the form on reload', async ({ page }) => {
    await openDescricaoTab(page);
    await expect(page.getByLabel('Descrição', { exact: true })).toHaveValue('Camiseta 100% algodão');
    await expect(page.getByLabel('Marca', { exact: true })).toHaveValue('Delfrance');
    await expect(page.getByLabel('Título', { exact: true })).toHaveValue('Camiseta básica');
  });
});
