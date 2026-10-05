import { expect, test } from '@playwright/test';
import { expectListMode } from './helpers/table-view';

/**
 * Transport coverage against the emulator. Filtered lists use the Enterprise
 * Pipelines API, which the Firestore emulator cannot execute; the supported
 * declared-query listener remains live and must load without an error.
 */
test.describe.serial('TableView list mode e2e — depósitos', () => {
  test('keeps the declared default query live', async ({ page }) => {
    await page.goto('/depositos');
    await expect(page.getByRole('heading', { name: 'Depósitos de estoque' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expectListMode(page, 'live', null, 'live');
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });
});
