import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  docExistsByName,
  e2ePrefix,
  getProdutoIdBySku,
  seedKitReferencing,
  seedProdutoComFilho,
  seedVariacaoMlLink,
} from './_helpers/seed-data';
import { clickSave, confirmDelete, expectToast } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the variation deletion-integrity work (#117):
 *  - recreating a deleted child with the same SKU keeps the original doc id;
 *  - sibling variations must not share a non-empty SKU (inline + save gate);
 *  - a child referenced by a kit or a marketplace link cannot be deleted;
 *  - deleting the parent cascades the children (after the same guard).
 */
test.describe.serial('Produtos — deletion integrity (#117)', () => {
  const prefix = e2ePrefix('prod-int');
  const recreatedNome = `${prefix}-recriada`;
  let parentId = '';
  let childId = '';
  let parentNome = '';
  let childNome = '';
  let childSku = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    [{ parentId, childId, parentNome, childNome, childSku }] = await Promise.all([
      seedProdutoComFilho(prefix),
      warmRoutes(browser, ['/produtos/__aquecimento__/editar']),
    ]);
  });

  test.afterAll(async () => {
    await cleanupProdutoSubcollection(childId, 'variacaoMercadoLivre');
    await cleanupByNamePrefix('produtos', prefix);
  });

  async function openVariacoes(page: Page) {
    await page.goto(`/produtos/${parentId}/editar`);
    await page.getByRole('tab', { name: 'Variações' }).click();
    await expect(page.getByRole('button', { name: 'Remover variação' })).toBeVisible({
      timeout: 15_000,
    });
  }

  /**
   * Fill the staged new row (always appended last). Role locators only match
   * visible elements, so the hidden Dados gerais panel's Nome/SKU inputs and
   * the rows above don't interfere — `.last()` is the fresh row.
   */
  async function fillNovaRow(page: Page, nome: string, sku: string) {
    await page.getByRole('button', { name: 'Nova variante' }).click();
    await expect(page.getByText('nova', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Nome' }).last().fill(nome);
    await page.getByRole('textbox', { name: 'SKU' }).last().fill(sku);
  }

  test('recreating a deleted child with the same SKU reuses the doc id', async ({ page }) => {
    await openVariacoes(page);

    // Stage-delete the persisted child, then recreate "the same" variation
    // (same SKU, different nome) as a manual row.
    await page.getByRole('button', { name: 'Remover variação' }).click();
    await expect(page.getByText('Será excluída')).toBeVisible();
    await fillNovaRow(page, recreatedNome, childSku);

    await clickSave(page, 'Salvar alterações');
    await expect(page.getByText(/reaproveitado/)).toBeVisible({ timeout: 15_000 });

    // The doc id survived the delete+recreate — everything keyed to it
    // (estoque, marketplace links, kit entries) stays intact.
    await expect.poll(() => getProdutoIdBySku(childSku), { timeout: 15_000 }).toBe(childId);
    await expect.poll(() => docExistsByName('produtos', recreatedNome)).toBe(true);
    await expect.poll(() => docExistsByName('produtos', childNome)).toBe(false);
  });

  test('duplicate sibling SKUs show inline errors and block the save', async ({ page }) => {
    await openVariacoes(page);

    await fillNovaRow(page, `${prefix}-dup`, childSku);
    await expect(page.getByText('SKU duplicado entre as variações').first()).toBeVisible();

    await clickSave(page, 'Salvar alterações');
    // The flush gate aborts before any write; the duplicate row is never created.
    await expect(page.getByText(/SKU duplicado entre as variações:/)).toBeVisible({
      timeout: 15_000,
    });
    await expect.poll(() => docExistsByName('produtos', `${prefix}-dup`)).toBe(false);
  });

  test('a child referenced by a kit cannot be stage-deleted', async ({ page }) => {
    const { kitNome } = await seedKitReferencing(prefix, childId);
    await openVariacoes(page);

    await page.getByRole('button', { name: 'Remover variação' }).click();
    await expectToast(page, /Não é possível excluir/);
    await expectToast(page, new RegExp(kitNome));
    await expect(page.getByText('Será excluída')).toHaveCount(0);

    // Drop the kit so the next tests exercise their own guards.
    await cleanupByNamePrefix('produtos', `${prefix}-kit`);
  });

  test('a child linked to a marketplace cannot be stage-deleted', async ({ page }) => {
    await seedVariacaoMlLink(childId);
    await openVariacoes(page);

    await page.getByRole('button', { name: 'Remover variação' }).click();
    await expectToast(page, /Não é possível excluir/);
    await expectToast(page, /Mercado Livre/);
    await expect(page.getByText('Será excluída')).toHaveCount(0);

    await cleanupProdutoSubcollection(childId, 'variacaoMercadoLivre');
  });

  test('parent delete is blocked while a child is referenced, then cascades children', async ({
    page,
  }) => {
    // Phase 1 — a kit referencing the child blocks the WHOLE parent delete.
    const { kitNome } = await seedKitReferencing(prefix, childId);
    await page.goto(`/produtos/${parentId}/editar`);
    await confirmDelete(page);
    await expectToast(page, /Não é possível excluir/);
    await expectToast(page, new RegExp(kitNome));
    await expect.poll(() => docExistsByName('produtos', parentNome)).toBe(true);

    // Phase 2 — without references, the parent AND its children go in one batch.
    await cleanupByNamePrefix('produtos', `${prefix}-kit`);
    await page.goto(`/produtos/${parentId}/editar`);
    await confirmDelete(page);
    await page.waitForURL(/\/produtos$/, { timeout: 15_000 });
    await expect
      .poll(() => docExistsByName('produtos', parentNome), { timeout: 15_000 })
      .toBe(false);
    await expect.poll(() => docExistsByName('produtos', recreatedNome)).toBe(false);
  });
});
