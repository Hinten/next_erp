import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupLixeira,
  docExistsByName,
  e2ePrefix,
  lixeiraEntryExists,
  seedLixeira,
} from './_helpers/seed-data';
import {
  applyTextFilter,
  clickAction,
  expectEmptyState,
  expectRowHidden,
  expectRowVisible,
  selectRowByText,
} from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/lixeira` recovery view, driven by
 * `lixeiraSchema`. Seeds 5 mock trash entries (snapshots of deleted
 * categorias, as the `onDelete` Cloud Function trigger would write them),
 * then exercises listing, filtering, restoring an entry back to its origin
 * collection, and purging an entry permanently. Runs serially.
 *
 * The Cloud Function trigger itself is not exercised here — it runs only on
 * deployed infrastructure; this suite seeds the `lixeira` collection directly
 * and validates the app-side recovery flow.
 */
test.describe.serial('Lixeira e2e — recuperação de itens excluídos', () => {
  const prefix = e2ePrefix('lix');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await Promise.all([
      seedLixeira(prefix, 5),
      warmRoutes(browser, ['/lixeira', '/categorias']),
    ]);
  });

  test.afterAll(async () => {
    await Promise.all([
      cleanupLixeira(prefix),
      // The restore test re-creates a categoria under the prefix.
      cleanupByNamePrefix('categorias', prefix),
    ]);
  });

  test('lista as entradas da lixeira', async ({ page }) => {
    await page.goto('/lixeira');
    await expect(
      page.getByRole('heading', { name: 'Itens excluídos' }),
    ).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('filtra entradas pela coluna Item', async ({ page }) => {
    await page.goto('/lixeira');
    await applyTextFilter(page, 'Item', row(3));
    await expectRowVisible(page, row(3));
    await expectRowHidden(page, row(1));
  });

  test('restaura um item para a coleção de origem', async ({ page }) => {
    await page.goto('/lixeira');
    await applyTextFilter(page, 'Item', row(2));
    await expectRowVisible(page, row(2));

    await selectRowByText(page, row(2));
    await clickAction(page, 'Restaurar', { confirm: false });

    // The categoria is re-created under its original id — Admin SDK reads are
    // strongly consistent, so polling here localises a failure to the restore.
    await expect
      .poll(() => docExistsByName('categorias', row(2)), { timeout: 15_000 })
      .toBe(true);

    // The trash entry is consumed by the restore.
    await page.goto('/lixeira');
    await applyTextFilter(page, 'Item', row(2));
    await expectEmptyState(page);

    // And the restored doc shows up in its origin collection.
    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', row(2));
    await expectRowVisible(page, row(2));
  });

  test('exclui um item definitivamente', async ({ page }) => {
    await page.goto('/lixeira');
    await applyTextFilter(page, 'Item', row(4));
    await expectRowVisible(page, row(4));

    await selectRowByText(page, row(4));
    await clickAction(page, 'Excluir definitivamente');

    // The purge is fire-and-forget from the ActionBar — poll the (strongly
    // consistent) Admin SDK so the re-listing below can't race the delete.
    await expect
      .poll(() => lixeiraEntryExists(row(4)), { timeout: 15_000 })
      .toBe(false);

    await page.goto('/lixeira');
    await applyTextFilter(page, 'Item', row(4));
    await expectEmptyState(page);

    // A permanent delete never restores the document.
    expect(await docExistsByName('categorias', row(4))).toBe(false);
  });
});
