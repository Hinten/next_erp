import { expect, test } from '@playwright/test';

import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/nfe/inutilizar` form. **Validation only** —
 * a successful submit performs a real, irreversible inutilização against
 * SEFAZ-SP HOM, so these tests deliberately never submit a valid range. The
 * live round-trip is covered by the gated homologação suite in `apps/nfe`.
 *
 * Rides the `crud` Playwright project (testMatch /\.e2e\.spec\.ts$/) — no
 * workflow change needed.
 */
test.describe('Inutilização de numeração — form validation', () => {
  test.beforeAll(async ({ browser }) => {
    await warmRoutes(browser, ['/nfe/inutilizar']);
  });

  test('renders the form for an authorized user', async ({ page }) => {
    await page.goto('/nfe/inutilizar');
    await expect(
      page.getByRole('heading', { name: 'Inutilizar numeração' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('button', { name: 'Inutilizar numeração' }),
    ).toBeVisible();
  });

  test('blocks submit and shows field errors when the form is empty', async ({ page }) => {
    await page.goto('/nfe/inutilizar');
    await page.getByRole('button', { name: 'Inutilizar numeração' }).click();

    await expect(page.getByText('Selecione uma filial')).toBeVisible();
    await expect(page.getByText(/justificativa deve ter ao menos 15/i)).toBeVisible();
    // Never reached SEFAZ — no result card.
    await expect(page.getByText(/Inutilização homologada/i)).toHaveCount(0);
    await expect(page).toHaveURL(/\/nfe\/inutilizar$/);
  });

  test('rejects an inverted range (nNFIni > nNFFin)', async ({ page }) => {
    await page.goto('/nfe/inutilizar');
    await page.getByLabel('Número inicial').fill('20');
    await page.getByLabel('Número final').fill('10');
    await page
      .getByLabel('Justificativa')
      .fill('Inutilizacao de faixa nao utilizada teste');
    await page.getByRole('button', { name: 'Inutilizar numeração' }).click();

    await expect(page.getByText(/número inicial deve ser .* ao número final/i)).toBeVisible();
    await expect(page.getByText(/Inutilização homologada/i)).toHaveCount(0);
  });
});
