import { expect, test } from '@playwright/test';
import { cleanupByNamePrefix, e2ePrefix, seedProdutoComFilho } from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';
import { searchTableView, tableViewSearchBox } from './helpers/table-view';

/**
 * End-to-end coverage for the produtos list parent-only filter (#119): the
 * list (default and searched) must show parent products and hide variation
 * children (`paiId != null`) — children are reached through their parent's
 * Variações tab. Also guards the name prefix search
 * and the FIXED column set (the screen passes `showColumnPicker={false}`, so
 * the headers are the schema's declaration rather than a saved preference).
 */
test.describe.serial('Produtos lista e2e — parents only (#119)', () => {
  const prefix = e2ePrefix('prod-lista');
  let parentNome = '';
  let childNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    [{ parentNome, childNome }] = await Promise.all([
      seedProdutoComFilho(prefix),
      warmRoutes(browser, ['/produtos', '/produtos/__aquecimento__/editar']),
    ]);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('produtos', prefix);
  });

  test('search lists the parent and hides the variation child', async ({ page }) => {
    await page.goto('/produtos');
    // Scope the assertion through the run-scoped prefix search so parallel
    // runs / other data can't interfere with the default page.
    await searchTableView(page, prefix);
    await expect(page.getByRole('link', { name: parentNome, exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('link', { name: childNome, exact: true })).toHaveCount(0);
  });

  test('prefix search finds the parent by a partial term', async ({ page }) => {
    await page.goto('/produtos');
    // A strict prefix of the name (not the full string) must match.
    await searchTableView(page, prefix.slice(0, prefix.length - 3));
    await expect(page.getByRole('link', { name: parentNome, exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('link', { name: childNome, exact: true })).toHaveCount(0);
  });

  test('shows the fixed column set and no column picker', async ({ page }) => {
    await page.goto('/produtos');
    await expect(page.getByRole('table')).toBeVisible({ timeout: 30_000 });

    // The set is declared once on `produtoMeta.defaultQuery.columns` and there
    // is no ⚙ to change it — which is also why asserting the headers here is
    // meaningful rather than a snapshot of somebody's saved preference.
    const headers = await page.getByRole('columnheader').allTextContents();
    expect(headers).toEqual(
      expect.arrayContaining([
        'Nome',
        'Sku',
        'Preço',
        'Status',
        'Canais de venda',
        'Última modificação',
      ]),
    );
    expect(headers).not.toContain('Gtin');

    await expect(page.getByRole('button', { name: 'Configurar colunas' })).toHaveCount(0);
  });

  test('keeps the search after opening a produto and cancelling', async ({ page }) => {
    await page.goto('/produtos');
    await searchTableView(page, prefix);
    await expect(page.getByRole('link', { name: parentNome, exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('link', { name: parentNome, exact: true }).click();
    await page.waitForURL(/\/produtos\/[^/]+\/editar$/, { timeout: 15_000 });

    // Cancelar goes to the BARE list path, so the term has to come back from
    // the per-screen memory rather than from the query string.
    await page.getByRole('link', { name: 'Cancelar' }).click();
    await page.waitForURL(/\/produtos(\?.*)?$/, { timeout: 15_000 });

    await expect(tableViewSearchBox(page)).toHaveValue(prefix);
    await expect(page.getByText(`Busca: "${prefix}"`)).toBeVisible();
    await expect(page.getByRole('link', { name: parentNome, exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('link', { name: childNome, exact: true })).toHaveCount(0);
  });
});
