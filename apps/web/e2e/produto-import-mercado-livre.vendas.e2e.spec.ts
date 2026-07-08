import { expect, test } from '@playwright/test';
import {
  cleanupMercadoLivreFixtures,
  e2ePrefix,
  seedMercadoLivreFixtures,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the "Importar do Mercado Livre" action on the produtos
 * LIST page (import CREATES a produto, so it lives on the list, not the editor
 * tab). The apps/mercado-livre backend does NOT run in this suite — the action
 * must degrade gracefully (error alert), never break the page.
 */
test.describe.serial('Produto import from Mercado Livre — modal + degradation', () => {
  const prefix = e2ePrefix('mlimp');
  const conta = `${prefix}-001`;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await Promise.all([seedMercadoLivreFixtures(prefix, 1), warmRoutes(browser, ['/produtos'])]);
  });

  test.afterAll(async () => {
    await cleanupMercadoLivreFixtures(prefix);
  });

  test('opens the import modal with the account + options', async ({ page }) => {
    await page.goto('/produtos');
    await page.getByRole('button', { name: 'Importar do Mercado Livre' }).click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(modal.getByLabel('Código do anúncio (MLB)')).toBeVisible();
    // The ported prefs surface as toggles; overwrite-stock defaults OFF (Lucas).
    await expect(modal.getByRole('checkbox', { name: 'Importar estoque' })).toBeChecked();
    await expect(
      modal.getByRole('checkbox', { name: 'Sobrescrever estoque existente' }),
    ).not.toBeChecked();
  });

  test('degrades gracefully when the backend is offline', async ({ page }) => {
    await page.goto('/produtos');
    await page.getByRole('button', { name: 'Importar do Mercado Livre' }).click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 30_000 });

    await modal.getByLabel('Conta').click();
    await page.getByRole('option', { name: conta }).click();
    await modal.getByLabel('Código do anúncio (MLB)').fill('MLB123456789');
    await modal.getByRole('button', { name: 'Importar' }).click();

    // Backend unreachable in this suite → an error alert, page still intact.
    await expect(modal.getByText('Não foi possível importar')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Importar do Mercado Livre' })).toBeVisible();
  });
});
