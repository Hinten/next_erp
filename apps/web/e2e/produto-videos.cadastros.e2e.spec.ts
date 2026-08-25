import { expect, test } from '@playwright/test';
import { cleanupByNamePrefix, docExistsByName, e2ePrefix } from './_helpers/seed-data';
import { clickSave, fillField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the product video manager. Creates a produto through
 * the ObjectView create screen, opens the editor and asserts the "Vídeos" tab
 * renders the upload dropzone + empty state. Guards the `videoSchema` +
 * ObjectView Vídeos-tab wiring against regressions.
 *
 * A real upload is intentionally NOT exercised here (it would leave orphan
 * `Arquivo` docs + Storage objects in staging — cleanup tracked in #95).
 */
test.describe.serial('Produtos vídeos e2e — ObjectView Vídeos tab', () => {
  const prefix = e2ePrefix('prod-video');
  const nome = `${prefix}-001`;

  test.beforeAll(async ({ browser }) => {
    // Cold-compiling the create + editor routes can outlast the default budget.
    test.setTimeout(240_000);
    await warmRoutes(browser, ['/produtos', '/produtos/novo', '/produtos/__aquecimento__/editar']);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('produtos', prefix);
  });

  test('shows the "save first" message on the Vídeos tab of the create screen', async ({
    page,
  }) => {
    await page.goto('/produtos/novo');
    await expect(page.getByRole('heading', { name: 'Novo produto' })).toBeVisible();
    await page.getByRole('tab', { name: 'Vídeos' }).click();
    // No produtoId yet → VideoManager prompts to save first, no dropzone.
    await expect(page.getByText('Salve o produto para poder enviar vídeos.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Arraste vídeos aqui ou clique para selecionar')).toHaveCount(0);
  });

  test('creates a produto and exposes the Vídeos tab in the editor', async ({ page }) => {
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

    // Already in the editor — switch to the Vídeos tab.
    await expect(page.getByRole('heading', { name: `Editar ${nome} - sem sku` })).toBeVisible();
    await page.getByRole('tab', { name: 'Vídeos' }).click();

    // The dropzone + empty state render (no videos yet). Generous timeout — the
    // VideoManager chunk may still be compiling on the dev server.
    await expect(page.getByText('Arraste vídeos aqui ou clique para selecionar')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Nenhum vídeo.')).toBeVisible();
  });
});
