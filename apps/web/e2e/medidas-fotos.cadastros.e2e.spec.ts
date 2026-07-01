import { expect, test } from '@playwright/test';
import { cleanupByNamePrefix, e2ePrefix, seedMedidas } from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * Render-only e2e for the medidas "Fotos" tab. Like `produto-fotos`, the full
 * upload round-trip is NOT exercised: a real upload would orphan staging Storage
 * objects + `arquivos` docs with no teardown path (tracked in #95). This guards
 * the `fotoSchema` + ObjectView Fotos-tab wiring (the shared PhotoManager with a
 * tabMedi adapter) against regressions: the save-first message on the create
 * screen, and the dropzone + empty state on a seeded tabela's `[id]` screen.
 */
test.describe.serial('Medidas fotos e2e — ObjectView Fotos tab', () => {
  const prefix = e2ePrefix('medi-foto');

  test.beforeAll(async ({ browser }) => {
    // Cold-compiling the create + [id] routes can outlast the default budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedMedidas(prefix, 1),
      warmRoutes(browser, ['/medidas', '/medidas/novo', '/medidas/__aquecimento__']),
    ]);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('tabMedi', prefix);
  });

  test('shows the "save first" message on the Fotos tab of the create screen', async ({ page }) => {
    await page.goto('/medidas/novo');
    await expect(page.getByRole('heading', { name: 'Nova tabela de medidas' })).toBeVisible();
    await page.getByRole('tab', { name: 'Fotos' }).click();
    // No tabMedi id yet → PhotoManager prompts to save first, no dropzone.
    await expect(page.getByText('Salve a tabela de medidas para enviar fotos.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Arraste imagens aqui ou clique para selecionar')).toHaveCount(0);
  });

  test('exposes the Fotos tab dropzone + empty state on a seeded tabela', async ({ page }) => {
    // seedMedidas writes `<prefix>-001` with `fotos: null` → the doc id is its nome.
    await page.goto(`/medidas/${prefix}-001`);
    await expect(page.getByRole('heading', { name: 'Tabela de medidas' })).toBeVisible();
    await page.getByRole('tab', { name: 'Fotos' }).click();
    // The dropzone + empty state render (no photos yet). Generous timeout — the
    // PhotoManager chunk may still be compiling on the dev server.
    await expect(page.getByText('Arraste imagens aqui ou clique para selecionar')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/Nenhuma foto/).first()).toBeVisible();
  });
});
