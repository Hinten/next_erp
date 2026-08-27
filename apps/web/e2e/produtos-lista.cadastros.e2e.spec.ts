import { expect, test } from '@playwright/test';
import { cleanupByNamePrefix, e2ePrefix, seedProdutoComFilho } from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the produtos list parent-only filter (#119): the
 * list (default and searched) must show parent products and hide variation
 * children (`paiId != null`) — children are reached through their parent's
 * Variações tab. Also guards the name prefix search.
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
    await page.getByPlaceholder('Buscar por nome…').fill(prefix);
    await expect(page.getByRole('link', { name: parentNome, exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('link', { name: childNome, exact: true })).toHaveCount(0);
  });

  test('prefix search finds the parent by a partial term', async ({ page }) => {
    await page.goto('/produtos');
    // A strict prefix of the name (not the full string) must match.
    await page.getByPlaceholder('Buscar por nome…').fill(prefix.slice(0, prefix.length - 3));
    await expect(page.getByRole('link', { name: parentNome, exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('link', { name: childNome, exact: true })).toHaveCount(0);
  });

  test('keeps the search after opening a produto and cancelling', async ({ page }) => {
    await page.goto('/produtos');
    await page.getByPlaceholder('Buscar por nome…').fill(prefix);
    await expect(page.getByRole('link', { name: parentNome, exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('link', { name: parentNome, exact: true }).click();
    await page.waitForURL(/\/produtos\/[^/]+\/editar$/, { timeout: 15_000 });

    // Cancelar goes to the BARE list path, so the term has to come back from
    // the per-screen memory rather than from the query string.
    await page.getByRole('link', { name: 'Cancelar' }).click();
    await page.waitForURL(/\/produtos(\?.*)?$/, { timeout: 15_000 });

    await expect(page.getByPlaceholder('Buscar por nome…')).toHaveValue(prefix);
    await expect(page.getByText(`Busca: "${prefix}"`)).toBeVisible();
    await expect(page.getByRole('link', { name: parentNome, exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('link', { name: childNome, exact: true })).toHaveCount(0);
  });
});
