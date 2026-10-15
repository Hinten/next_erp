import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  docExistsByName,
  e2ePrefix,
  seedDepositos,
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
  expectFieldAfterReload,
  expectFieldError,
  expectToast,
  fillField,
} from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/depositos` TableView + ObjectView flow,
 * driven by `depositoSchema`. Seeds 7 mock depósitos (Admin SDK), then
 * exercises listing, per-column filtering (text + boolean), sorting,
 * create/edit/delete, schema-validation feedback (`nome` is required), the
 * unsaved-changes guard and URL query-param persistence. Runs serially.
 */
test.describe.serial('Depositos e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('dep');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async ({ browser }) => {
    // Compiling 3 cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedDepositos(prefix, 7),
      warmRoutes(browser, ['/depositos', '/depositos/novo', '/depositos/__aquecimento__']),
    ]);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('depositos', prefix);
  });

  test('TableView query works without a filter', async ({ page }) => {
    await page.goto('/depositos');
    await expect(page.getByRole('heading', { name: 'Depósitos de estoque' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('filters rows by the Nome (text) and Ativo (boolean) columns', async ({ page }) => {
    await page.goto('/depositos');
    await applyTextFilter(page, 'Nome', row(3));
    await expectRowVisible(page, row(3));
    await expectRowHidden(page, row(1));
    await clearColumnFilter(page, 'Nome');

    // Seeded ativo = (i % 2 === 0) → true at i=2,4,6.
    await applyTextFilter(page, 'Nome', prefix);
    await applySelectFilter(page, 'Ativo', 'Sim');
    await expectRowVisible(page, row(2));
    await expectRowHidden(page, row(1));
  });

  test('shows the empty state when a filter matches nothing', async ({ page }) => {
    await page.goto('/depositos');
    await applyTextFilter(page, 'Nome', `${prefix}-sem-correspondencia`);
    await expectEmptyState(page);
  });

  test('sorts rows by clicking the Nome column header', async ({ page }) => {
    await page.goto('/depositos');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(1));
    await expect.poll(() => firstRowText(page)).toContain(row(1));

    await clickColumnSort(page, 'Nome'); // asc → desc
    await expect(page).toHaveURL(/sort=nome%3Adesc/);
    await expect.poll(() => firstRowText(page)).toContain(row(7));

    await clickColumnSort(page, 'Nome'); // desc → asc
    await expect.poll(() => firstRowText(page)).toContain(row(1));
  });

  test('navigates to the new-deposito page', async ({ page }) => {
    await page.goto('/depositos');
    await page.getByRole('link', { name: 'Novo depósito' }).click();
    await expect(page).toHaveURL(/\/depositos\/novo$/);
    await expect(page.getByRole('heading', { name: 'Novo depósito' })).toBeVisible();
  });

  test('creates a new deposito', async ({ page }) => {
    const nome = `${prefix}-novo`;
    await page.goto('/depositos/novo');
    await fillField(page, 'Nome', nome);
    await clickSave(page, 'Criar');
    await page.waitForURL(
      (url) => /^\/depositos\/[^/]+$/.test(url.pathname) && url.pathname !== '/depositos/novo',
      { timeout: 15_000 },
    );
    await expect.poll(() => docExistsByName('depositos', nome), { timeout: 15_000 }).toBe(true);

    await page.goto('/depositos');
    await applyTextFilter(page, 'Nome', nome);
    await expectRowVisible(page, nome);
  });

  test('rejects creating a deposito without a Nome (required field)', async ({ page }) => {
    await page.goto('/depositos/novo');
    await clickSave(page, 'Criar');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/depositos\/novo$/);
  });

  test('opens an existing deposito from the list', async ({ page }) => {
    await page.goto('/depositos');
    await applyTextFilter(page, 'Nome', row(2));
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/depositos\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('warns about unsaved changes when leaving the edit page', async ({ page }) => {
    await page.goto(`/depositos/${row(4)}`);
    await fillField(page, 'Nome', `${prefix}-004-edicao-nao-salva`);

    let dialogSeen = false;
    page.once('dialog', (d) => {
      dialogSeen = true;
      void d.dismiss();
    });
    await page.getByRole('link', { name: 'Voltar à lista' }).click();
    await expect.poll(() => dialogSeen).toBe(true);
    await expect(page).toHaveURL(/\/depositos\/[^/]+$/);
  });

  test('edits a deposito and saves', async ({ page }) => {
    await page.goto(`/depositos/${row(5)}`);
    await fillField(page, 'Nome', `${prefix}-005-editado`);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/depositos$/, { timeout: 15_000 });

    await page.goto(`/depositos/${row(5)}`);
    await expectFieldAfterReload(page, 'Nome', `${prefix}-005-editado`);
  });

  test('edits a deposito and continues editing', async ({ page }) => {
    await page.goto(`/depositos/${row(6)}`);
    await fillField(page, 'Nome', `${prefix}-006-continua`);
    await clickSaveAndContinue(page);
    await expectToast(page, /Salvo/);
    await expect(page).toHaveURL(/\/depositos\/[^/]+$/);
  });

  test('rejects editing a deposito with an empty Nome', async ({ page }) => {
    await page.goto(`/depositos/${row(1)}`);
    await fillField(page, 'Nome', '');
    await clickSave(page, 'Salvar alterações');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/depositos\/[^/]+$/);
  });

  test('deletes a deposito through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/depositos/${row(7)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/depositos$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', row(7));
    await expectEmptyState(page);
  });

  test('keeps column filters in the URL query string', async ({ page }) => {
    await page.goto('/depositos');
    await applyTextFilter(page, 'Nome', row(2));
    await expect(page).toHaveURL(/nome=contains%3A/);

    await page.reload();
    await expectRowVisible(page, row(2));
    await expectRowHidden(page, row(1));

    await clearColumnFilter(page, 'Nome');
    await expect(page).not.toHaveURL(/nome=contains/);
  });

  test('keeps the sort in the URL and persists hidden columns', async ({ page }) => {
    await page.goto('/depositos');
    await clickColumnSort(page, 'Ativo');
    await expect(page).toHaveURL(/sort=ativo%3A/);

    await page.getByRole('button', { name: 'Configurar colunas' }).click();
    await page.getByRole('checkbox', { name: 'Ativo' }).uncheck();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByRole('columnheader', { name: /Ativo/ })).toHaveCount(0);
  });
});
