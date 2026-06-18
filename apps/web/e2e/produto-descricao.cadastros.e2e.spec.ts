import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  e2ePrefix,
  getProdutoData,
  getProdutoExtraData,
  getProdutoIdByNome,
} from './_helpers/seed-data';
import { fillField, selectField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the Descrição + Google Merchant tab — the first
 * consumer of the ObjectView `transientFields` enabler. It proves the
 * `extraData` aggregate field is persisted to its singleton subdocument
 * (`produtos/<id>/extraData/singleton`) with the exact Flutter wire shape and
 * kept OFF the produto document (the transient strip).
 *
 * Driven through the CREATE flow on purpose: the `novo` page runs no variation
 * `gruposQuery` and its `onAfterSave` has no child flush, so the save is a
 * simple "create produto + write singleton" — far less flaky on CI than the
 * editar save, whose late, post-flush singleton write races slow staging I/O.
 */
test.describe
  .serial('Produtos descrição e2e — Descrição + Google Merchant (extraData singleton)', () => {
  const prefix = e2ePrefix('prod-extradata');
  const nome = `${prefix}-camiseta`;
  let produtoId = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    await warmRoutes(browser, ['/produtos/novo']);
  });

  test.afterAll(async () => {
    if (produtoId) await cleanupProdutoSubcollection(produtoId, 'extraData');
    await cleanupByNamePrefix('produtos', prefix);
  });

  // The "Descrição" tab panel ALSO carries the accessible name "Descrição"
  // (Mantine's tabpanel is aria-labelledby its tab), so `getByLabel('Descrição')`
  // is ambiguous — scope to the textarea via its `textbox` role.
  const descricaoBox = (page: Page) =>
    page.getByRole('textbox', { name: 'Descrição', exact: true });

  async function fillDescricaoTab(page: Page) {
    await page.getByRole('tab', { name: 'Descrição' }).click();
    await descricaoBox(page).fill('Camiseta 100% algodão');
    await descricaoBox(page).blur();
    await fillField(page, 'Marca', 'Delfrance');
    await selectField(page, 'Condição', 'Usado');
    // Google Merchant block.
    await fillField(page, 'Título', 'Camiseta básica');
    await selectField(page, 'Faixa etária', 'Juvenil/Adulto (13 anos ou mais)');
  }

  test('creates a produto and persists its extraData singleton off the produto doc', async ({
    page,
  }) => {
    await page.goto('/produtos/novo');
    await fillField(page, 'Nome', nome);
    await fillDescricaoTab(page);
    await page.getByRole('button', { name: 'Criar', exact: true }).click();

    // Navigation-independent: poll Firestore for the created produto by its
    // unique name (the create commit), then for its extraData singleton (the
    // `onAfterSave` write that runs right after — the create save has no child
    // flush). Decoupling from the app's redirect keeps the test off the slow
    // staging save's tail.
    await expect
      .poll(async () => await getProdutoIdByNome(nome), { timeout: 30_000 })
      .not.toBeNull();
    produtoId = (await getProdutoIdByNome(nome))!;

    // The singleton carries the exact Flutter wire shape (condicao is the int
    // 2 = usado; the GMD block keeps its snake_case keys).
    await expect
      .poll(async () => (await getProdutoExtraData(produtoId))?.descricao, { timeout: 15_000 })
      .toBe('Camiseta 100% algodão');
    const extra = await getProdutoExtraData(produtoId);
    expect(extra).toMatchObject({
      descricao: 'Camiseta 100% algodão',
      marca: 'Delfrance',
      condicao: 2,
    });
    expect(extra!.googleMerchantData).toMatchObject({
      title: 'Camiseta básica',
      age_group: 'adult',
    });

    // The transient field never leaked onto the produto document.
    const produto = await getProdutoData(produtoId);
    expect(produto).not.toHaveProperty('extraData');
    expect(produto).not.toHaveProperty('descricao');
  });
});
