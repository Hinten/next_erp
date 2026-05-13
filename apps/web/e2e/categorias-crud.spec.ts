import { expect, test } from '@playwright/test';
import { requiresAuthEnv } from './helpers/env';
import {
  clearNullableField,
  clickSave,
  clickSaveAndContinue,
  expectToast,
  fillField,
} from './helpers/object-view';
import {
  clickAction,
  expectNoRowWithText,
  expectRowWithText,
  searchTable,
  selectRowByText,
} from './helpers/table-view';

test.skip(
  !requiresAuthEnv(),
  'E2E auth env not configured (E2E_USER_EMAIL/PASSWORD + Firebase Admin secrets)',
);

/**
 * Each test mints fresh ids prefixed with `e2e-` so globalTeardown's
 * `cleanupE2EDocs('categorias', 'e2e-')` can sweep stragglers. Names embed
 * the timestamp + worker index so parallel workers don't collide.
 */
function uniqueName(label: string, workerIndex: number): string {
  return `e2e-${label}-${workerIndex}-${Date.now()}`;
}

test.describe('Categorias CRUD', () => {
  test('list loads and renders the TableView shell', async ({ page }) => {
    await page.goto('/categorias');
    await expect(
      page.getByRole('heading', { name: 'Categorias' }),
    ).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: 'Nome' }),
    ).toBeVisible();
  });

  test('create → list → edit → save-and-continue → pristine save', async ({
    page,
  }, testInfo) => {
    const nome = uniqueName('cat', testInfo.workerIndex);
    const nomeEditado = `${nome}-editado`;

    // --- Create
    await page.goto('/categorias/novo');
    await fillField(page, 'Nome', nome);
    await fillField(page, 'Nome completo', `${nome} completo`);
    await clickSave(page, 'Criar');
    // Redirected to /categorias/<id>
    await page.waitForURL(/\/categorias\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: nome })).toBeVisible();

    // --- Appears in the list (with debounced search)
    await page.goto('/categorias');
    await searchTable(page, nome);
    await expectRowWithText(page, nome);

    // --- Edit
    await page.getByRole('link', { name: nome }).click();
    await page.waitForURL(/\/categorias\/[^/]+$/);
    await page.getByRole('link', { name: 'Editar' }).click();
    await page.waitForURL(/\/categorias\/[^/]+\/editar$/);
    await fillField(page, 'Nome', nomeEditado);

    // --- Save and continue: stays on the form, dirty cleared, green toast
    await clickSaveAndContinue(page);
    await expectToast(page, /Salvo/);
    await expect(page).toHaveURL(/\/categorias\/[^/]+\/editar$/);

    // --- Pristine save: no changes → yellow "Nenhuma alteração" toast
    await clickSave(page, 'Salvar alterações');
    await expectToast(page, /Nenhuma altera/);

    // --- Real save on a fresh edit, then back to detail
    await fillField(page, 'Nome completo', `${nome} ainda completo`);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/categorias\/[^/]+$/, { timeout: 10_000 });
    await expect(
      page.getByRole('heading', { name: nomeEditado }),
    ).toBeVisible();
  });

  test('null-clear: ✕ on `Nome completo` writes literal null', async ({
    page,
  }, testInfo) => {
    const nome = uniqueName('cat-null', testInfo.workerIndex);

    await page.goto('/categorias/novo');
    await fillField(page, 'Nome', nome);
    await fillField(page, 'Nome completo', 'sera apagado');
    await clickSave(page, 'Criar');
    await page.waitForURL(/\/categorias\/[^/]+$/, { timeout: 10_000 });

    await page.getByRole('link', { name: 'Editar' }).click();
    await page.waitForURL(/\/categorias\/[^/]+\/editar$/);

    // Clear and save
    await clearNullableField(page, 'Nome completo');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/categorias\/[^/]+$/, { timeout: 10_000 });

    // Detail view hides the "Nome completo" line entirely when null —
    // verify by going back to edit and checking the input is empty.
    await page.getByRole('link', { name: 'Editar' }).click();
    await page.waitForURL(/\/categorias\/[^/]+\/editar$/);
    await expect(page.getByLabel('Nome completo', { exact: true })).toHaveValue('');
  });

  test('bulk delete via ActionBar removes the row', async ({ page }, testInfo) => {
    const nome = uniqueName('cat-del', testInfo.workerIndex);

    // Create a throwaway row to delete.
    await page.goto('/categorias/novo');
    await fillField(page, 'Nome', nome);
    await clickSave(page, 'Criar');
    await page.waitForURL(/\/categorias\/[^/]+$/, { timeout: 10_000 });

    await page.goto('/categorias');
    await searchTable(page, nome);
    await selectRowByText(page, nome);
    await clickAction(page, 'Excluir');
    await expectNoRowWithText(page, nome);
  });

  test('pagination buttons are present (no-op today, see TableView TODO)', async ({
    page,
  }) => {
    await page.goto('/categorias');
    // Both buttons exist; "Próximo" may or may not be enabled depending on
    // seeded volume — assert presence only, not state.
    await expect(
      page.getByRole('button', { name: /Anterior/ }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Próximo/ })).toBeVisible();
  });
});
