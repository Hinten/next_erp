import { expect, test } from '@playwright/test';
import { cleanupByNamePrefix, docExistsByName, e2ePrefix } from './_helpers/seed-data';
import { clickSave, fillField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the product photo manager. Creates a produto
 * through the ObjectView create screen, opens the editor and asserts the
 * "Fotos" tab renders the upload dropzone and empty state. This guards the
 * `fotoSchema` + ObjectView Fotos-tab wiring against regressions.
 *
 * The full upload → resize round-trip is intentionally NOT exercised here: the
 * resize Cloud Function isn't deployed yet, and a real upload would leave
 * orphan `Arquivo` docs + Storage objects in staging (cleanup is tracked in the
 * deletion/orphan-lifecycle issue #95). It lands once the function is deployed.
 */
test.describe.serial('Produtos fotos e2e — ObjectView Fotos tab', () => {
  const prefix = e2ePrefix('prod-foto');
  const nome = `${prefix}-001`;

  test.beforeAll(async ({ browser }) => {
    // Cold-compiling the create + editor routes can outlast the default budget.
    test.setTimeout(240_000);
    await warmRoutes(browser, ['/produtos', '/produtos/novo', '/produtos/__aquecimento__/editar']);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('produtos', prefix);
  });

  test('shows the "save first" message on the Fotos tab of the create screen', async ({ page }) => {
    await page.goto('/produtos/novo');
    await expect(page.getByRole('heading', { name: 'Novo produto' })).toBeVisible();
    await page.getByRole('tab', { name: 'Fotos' }).click();
    // No produtoId yet → PhotoManager prompts to save first, no dropzone.
    await expect(page.getByText('Salve o produto para poder enviar fotos.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Arraste imagens aqui ou clique para selecionar')).toHaveCount(0);
  });

  test('creates a produto and exposes the Fotos tab in the editor', async ({ page }) => {
    // Create via the ObjectView create screen — only `nome` is required.
    await page.goto('/produtos/novo');
    await expect(page.getByRole('heading', { name: 'Novo produto' })).toBeVisible();
    await fillField(page, 'Nome', nome);
    await clickSave(page, 'Criar');

    // onSaved → router.replace('/produtos/<id>/editar') — create lands straight
    // in the editor (the intermediate detail view was removed).
    await page.waitForURL((url) => /^\/produtos\/[^/]+\/editar$/.test(url.pathname), {
      timeout: 15_000,
    });
    await expect.poll(() => docExistsByName('produtos', nome), { timeout: 15_000 }).toBe(true);

    // Already in the editor — switch to the Fotos tab.
    await expect(page.getByRole('heading', { name: 'Editar produto' })).toBeVisible();
    await page.getByRole('tab', { name: 'Fotos' }).click();

    // The dropzone + empty state render (no photos yet). Generous timeout — the
    // PhotoManager chunk may still be compiling on the dev server.
    await expect(page.getByText('Arraste imagens aqui ou clique para selecionar')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Nenhuma foto.')).toBeVisible();
  });
});
