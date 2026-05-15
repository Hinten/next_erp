import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  e2ePrefix,
  seedClientes,
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
  expectErrorText,
  expectFieldError,
  expectToast,
  fillField,
  selectField,
} from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/clientes` TableView + ObjectView flow,
 * driven by the `clienteSchema`. Seeds 7 mock clientes (Admin SDK), then
 * exercises listing, per-column filtering, sorting, create/edit/delete,
 * schema-validation feedback, the unsaved-changes guard and URL query-param
 * persistence. Runs serially — later steps consume earlier state.
 */
test.describe.serial('Clientes e2e — TableView / ObjectView', () => {
  // Run-scoped name prefix shared by seeded + UI-created docs.
  const prefix = e2ePrefix('cli');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async ({ browser }) => {
    // Compiling 3 cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedClientes(prefix, 7),
      // Pre-compile the routes this suite drives so the Next dev cold-compile
      // cost isn't charged to the first assertion (was flaking on 5s expects).
      warmRoutes(browser, [
        '/clientes',
        '/clientes/novo',
        '/clientes/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('clientes', prefix);
  });

  test('TableView query works without a filter', async ({ page }) => {
    await page.goto('/clientes');
    await expect(page.getByRole('heading', { name: 'Clientes' })).toBeVisible();
    // The table only mounts once the (one-shot) Pipelines query resolves —
    // a preview API that can lag well past the 5s default expect timeout.
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    // A failed pipeline query renders an "Erro ao carregar" alert.
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('filters rows by the Nome (text) and Tipo (enum) columns', async ({ page }) => {
    await page.goto('/clientes');
    await applyTextFilter(page, 'Nome', row(3));
    await expectRowVisible(page, row(3));
    await expectRowHidden(page, row(1));
    await clearColumnFilter(page, 'Nome');

    // Seeded tipo cycles ['1','2','0',...] over i=1..7 → tipo '0' at i=3,6.
    await applyTextFilter(page, 'Nome', prefix);
    await applySelectFilter(page, 'Tipo', 'Pessoa Física');
    await expectRowVisible(page, row(3));
    await expectRowHidden(page, row(1));
  });

  test('shows the empty state when a filter matches nothing', async ({ page }) => {
    await page.goto('/clientes');
    await applyTextFilter(page, 'Nome', `${prefix}-sem-correspondencia`);
    await expectEmptyState(page);
  });

  test('sorts rows by clicking the Nome column header', async ({ page }) => {
    await page.goto('/clientes');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(1));
    // Default load is nome:asc — first row is -001.
    await expect.poll(() => firstRowText(page)).toContain(row(1));

    await clickColumnSort(page, 'Nome'); // asc → desc
    await expect(page).toHaveURL(/sort=nome%3Adesc/);
    await expect.poll(() => firstRowText(page)).toContain(row(7));

    await clickColumnSort(page, 'Nome'); // desc → asc
    await expect.poll(() => firstRowText(page)).toContain(row(1));
  });

  test('navigates to the new-cliente page', async ({ page }) => {
    await page.goto('/clientes');
    await page.getByRole('link', { name: 'Novo cliente' }).click();
    await expect(page).toHaveURL(/\/clientes\/novo$/);
    await expect(page.getByRole('heading', { name: 'Novo cliente' })).toBeVisible();
  });

  test('creates a new cliente', async ({ page }) => {
    const nome = `${prefix}-novo`;
    await page.goto('/clientes/novo');
    await fillField(page, 'Nome', nome);
    await selectField(page, 'Tipo', 'Pessoa Física');
    await fillField(page, 'CPF / CNPJ', '12345678901');
    await fillField(page, 'E-mail', `${prefix}-novo@example.com`);
    await clickSave(page, 'Criar');
    await page.waitForURL(/\/clientes\/[^/]+$/, { timeout: 15_000 });

    await page.goto('/clientes');
    await applyTextFilter(page, 'Nome', nome);
    await expectRowVisible(page, nome);
  });

  test('rejects creating a cliente with an invalid CPF/CNPJ', async ({ page }) => {
    await page.goto('/clientes/novo');
    await fillField(page, 'Nome', `${prefix}-erro`);
    await fillField(page, 'CPF / CNPJ', 'abc'); // letters → regex fails
    await clickSave(page, 'Criar');
    await expectErrorText(page, 'apenas números');
    await expect(page).toHaveURL(/\/clientes\/novo$/);
  });

  test('opens an existing cliente from the list', async ({ page }) => {
    await page.goto('/clientes');
    await applyTextFilter(page, 'Nome', row(2));
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/clientes\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('warns about unsaved changes when leaving the edit page', async ({ page }) => {
    await page.goto(`/clientes/${row(4)}`);
    await fillField(page, 'Observações internas', 'edicao-nao-salva');

    // The unsaved-changes guard uses window.confirm; capture + dismiss.
    let dialogSeen = false;
    page.once('dialog', (d) => {
      dialogSeen = true;
      void d.dismiss();
    });
    await page.getByRole('link', { name: 'Voltar à lista' }).click();
    await expect.poll(() => dialogSeen).toBe(true);
    await expect(page).toHaveURL(/\/clientes\/[^/]+$/); // dismissed → stayed
  });

  test('edits a cliente and saves', async ({ page }) => {
    await page.goto(`/clientes/${row(5)}`);
    await fillField(page, 'Observações internas', 'editado-e2e');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/clientes$/, { timeout: 15_000 });

    await page.goto(`/clientes/${row(5)}`);
    await expect(
      page.getByLabel('Observações internas', { exact: true }),
    ).toHaveValue('editado-e2e');
  });

  test('edits a cliente and continues editing', async ({ page }) => {
    await page.goto(`/clientes/${row(6)}`);
    await fillField(page, 'Observações internas', 'continua-editando');
    await clickSaveAndContinue(page);
    await expectToast(page, /Salvo/);
    await expect(page).toHaveURL(/\/clientes\/[^/]+$/); // stayed on the form
  });

  test('rejects editing a cliente with an invalid e-mail', async ({ page }) => {
    await page.goto(`/clientes/${row(1)}`);
    await fillField(page, 'E-mail', 'nao-e-um-email');
    await clickSave(page, 'Salvar alterações');
    await expectFieldError(page, 'E-mail');
    await expect(page).toHaveURL(/\/clientes\/[^/]+$/);
  });

  test('deletes a cliente through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/clientes/${row(7)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/clientes$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', row(7));
    await expectEmptyState(page);
  });

  test('keeps column filters in the URL query string', async ({ page }) => {
    await page.goto('/clientes');
    await applyTextFilter(page, 'Nome', row(2));
    await expect(page).toHaveURL(/nome=contains%3A/);

    await page.reload();
    await expectRowVisible(page, row(2));
    await expectRowHidden(page, row(1));

    await clearColumnFilter(page, 'Nome');
    await expect(page).not.toHaveURL(/nome=contains/);
  });

  test('keeps the sort in the URL and persists hidden columns', async ({ page }) => {
    await page.goto('/clientes');
    await clickColumnSort(page, 'Tipo');
    await expect(page).toHaveURL(/sort=tipo%3A/);

    // Hide the E-mail column; the choice persists via localStorage.
    await page.getByRole('button', { name: 'Configurar colunas' }).click();
    await page.getByRole('checkbox', { name: 'E-mail' }).uncheck();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByRole('columnheader', { name: /E-mail/ })).toHaveCount(0);
  });
});
