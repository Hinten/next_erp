import { expect, test } from '@playwright/test';
import { e2ePrefix } from './_helpers/seed-data';
import { applyTextFilter, expectListMode, transitionListMode } from './helpers/table-view';

/**
 * Transport coverage against the emulator: the default declared list keeps
 * itself current, while an operator filter deliberately fixes its result set.
 */
test.describe.serial('TableView list mode e2e — depósitos', () => {
  // No record fixture is needed: this assertion is about the transport chosen
  // by a filter gesture, not about an eventual row result.
  const filterValue = e2ePrefix('list-mode');

  test('keeps default results current and fixes filtered results', async ({ page }) => {
    await page.goto('/depositos');
    await expect(page.getByRole('heading', { name: 'Depósitos de estoque' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expectListMode(page, 'live');

    await transitionListMode(page, 'static', () => applyTextFilter(page, 'Nome', filterValue));
    await expectListMode(page, 'static', 'filter');
  });
});
