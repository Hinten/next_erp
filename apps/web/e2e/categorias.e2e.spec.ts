import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  e2ePrefix,
  seedCategorias,
} from './_helpers/seed-data';
import {
  applySelectFilter,
  applyTextFilter,
  clearColumnFilter,
  clickColumnSort,
  expectEmptyState,
  expectRowHidden,
  expectRowVisible,
  firstRowText,
} from './helpers/table-view';
import {
  clickSave,
  clickSaveAndContinue,
  confirmDelete,
  expectFieldError,
  expectToast,
  fillField,
} from './helpers/object-view';

/**
 * End-to-end coverage for the `/categorias` TableView + ObjectView flow,
 * driven by the `categoriaSchema`. Seeds 7 mock categorias (Admin SDK),
 * then exercises listing, per-column filtering (text + boolean), sorting,
 * create/edit/delete, schema-validation feedback (`nome` is required), the
 * unsaved-changes guard and URL query-param persistence. Runs serially.
 */
test.describe.serial('Categorias e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('cat');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async () => {
    await seedCategorias(prefix, 7);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('categorias', prefix);
  });

  test('TableView query works without a filter', async ({ page }) => {
    await page.goto('/categorias');
    await expect(page.getByRole('heading', { name: 'Categorias' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('filters rows by the Nome (text) and Permite cadastro (boolean) columns', async ({
    page,
  }) => {
    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', row(3));
    await expectRowVisible(page, row(3));
    await expectRowHidden(page, row(1));
    await clearColumnFilter(page, 'Nome');

    // Seeded permiteCadastro = (i % 2 === 0) → true at i=2,4,6.
    await applyTextFilter(page, 'Nome', prefix);
    await applySelectFilter(page, 'Permite cadastro', 'Sim');
    await expectRowVisible(page, row(2));
    await expectRowHidden(page, row(1));
  });

  test('shows the empty state when a filter matches nothing', async ({ page }) => {
    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', `${prefix}-sem-correspondencia`);
    await expectEmptyState(page);
  });

  test('sorts rows by clicking the Nome column header', async ({ page }) => {
    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(1));
    await expect.poll(() => firstRowText(page)).toContain(row(1));

    await clickColumnSort(page, 'Nome'); // asc → desc
    await expect(page).toHaveURL(/sort=nome%3Adesc/);
    await expect.poll(() => firstRowText(page)).toContain(row(7));

    await clickColumnSort(page, 'Nome'); // desc → asc
    await expect.poll(() => firstRowText(page)).toContain(row(1));
  });

  test('navigates to the new-categoria page', async ({ page }) => {
    await page.goto('/categorias');
    await page.getByRole('link', { name: 'Nova categoria' }).click();
    await expect(page).toHaveURL(/\/categorias\/novo$/);
    await expect(page.getByRole('heading', { name: 'Nova categoria' })).toBeVisible();
  });

  test('creates a new categoria', async ({ page }) => {
    const nome = `${prefix}-novo`;
    await page.goto('/categorias/novo');
    await fillField(page, 'Nome', nome);
    await clickSave(page, 'Criar');
    await page.waitForURL(/\/categorias\/[^/]+$/, { timeout: 15_000 });

    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', nome);
    await expectRowVisible(page, nome);
  });

  test('rejects creating a categoria without a Nome (required field)', async ({ page }) => {
    await page.goto('/categorias/novo');
    // Leave "Nome" empty — categoriaSchema requires nome.min(1).
    await clickSave(page, 'Criar');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/categorias\/novo$/);
  });

  test('opens an existing categoria from the list', async ({ page }) => {
    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', row(2));
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/categorias\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('warns about unsaved changes when leaving the edit page', async ({ page }) => {
    await page.goto(`/categorias/${row(4)}`);
    await fillField(page, 'Nome completo', 'edicao-nao-salva');

    let dialogSeen = false;
    page.once('dialog', (d) => {
      dialogSeen = true;
      void d.dismiss();
    });
    await page.getByRole('link', { name: 'Voltar à lista' }).click();
    await expect.poll(() => dialogSeen).toBe(true);
    await expect(page).toHaveURL(/\/categorias\/[^/]+$/);
  });

  test('edits a categoria and saves', async ({ page }) => {
    await page.goto(`/categorias/${row(5)}`);
    await fillField(page, 'Nome completo', 'editado-e2e');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/categorias$/, { timeout: 15_000 });

    await page.goto(`/categorias/${row(5)}`);
    await expect(
      page.getByLabel('Nome completo', { exact: true }),
    ).toHaveValue('editado-e2e');
  });

  test('edits a categoria and continues editing', async ({ page }) => {
    await page.goto(`/categorias/${row(6)}`);
    await fillField(page, 'Nome completo', 'continua-editando');
    await clickSaveAndContinue(page);
    await expectToast(page, /Salvo/);
    await expect(page).toHaveURL(/\/categorias\/[^/]+$/);
  });

  test('rejects editing a categoria with an empty Nome', async ({ page }) => {
    await page.goto(`/categorias/${row(1)}`);
    await fillField(page, 'Nome', '');
    await clickSave(page, 'Salvar alterações');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/categorias\/[^/]+$/);
  });

  test('deletes a categoria through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/categorias/${row(7)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/categorias$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', row(7));
    await expectEmptyState(page);
  });

  test('keeps column filters in the URL query string', async ({ page }) => {
    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', row(2));
    await expect(page).toHaveURL(/nome=contains%3A/);

    await page.reload();
    await expectRowVisible(page, row(2));
    await expectRowHidden(page, row(1));

    await clearColumnFilter(page, 'Nome');
    await expect(page).not.toHaveURL(/nome=contains/);
  });

  test('keeps the sort in the URL and persists hidden columns', async ({ page }) => {
    await page.goto('/categorias');
    await clickColumnSort(page, 'Nome completo');
    await expect(page).toHaveURL(/sort=nomeCompleto%3A/);

    await page.getByRole('button', { name: 'Configurar colunas' }).click();
    await page.getByRole('checkbox', { name: 'Nome completo' }).uncheck();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(
      page.getByRole('columnheader', { name: /Nome completo/ }),
    ).toHaveCount(0);
  });
});
