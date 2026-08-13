import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  docExistsByName,
  e2ePrefix,
  seedMotivosIncidente,
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
 * End-to-end coverage for the `/motivos-incidente` TableView + ObjectView
 * flow, driven by `motivoIncidenteSchema`. Seeds 7 mock motivos (Admin SDK),
 * then exercises listing, per-column filtering (text + boolean), sorting,
 * create/edit/delete, schema-validation feedback (`nome` is required), the
 * unsaved-changes guard and URL query-param persistence. Runs serially.
 */
test.describe.serial('Motivos de incidente e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('mot');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async ({ browser }) => {
    // Compiling 3 cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedMotivosIncidente(prefix, 7),
      warmRoutes(browser, [
        '/motivos-incidente',
        '/motivos-incidente/novo',
        '/motivos-incidente/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('motivosincidentes', prefix);
  });

  test('TableView query works without a filter', async ({ page }) => {
    await page.goto('/motivos-incidente');
    await expect(page.getByRole('heading', { name: 'Motivos de incidente' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('filters rows by the Nome (text) and Ativo (boolean) columns', async ({ page }) => {
    await page.goto('/motivos-incidente');
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
    await page.goto('/motivos-incidente');
    await applyTextFilter(page, 'Nome', `${prefix}-sem-correspondencia`);
    await expectEmptyState(page);
  });

  test('sorts rows by clicking the Nome column header', async ({ page }) => {
    await page.goto('/motivos-incidente');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(1));
    await expect.poll(() => firstRowText(page)).toContain(row(1));

    await clickColumnSort(page, 'Nome'); // asc → desc
    await expect(page).toHaveURL(/sort=nome%3Adesc/);
    await expect.poll(() => firstRowText(page)).toContain(row(7));

    await clickColumnSort(page, 'Nome'); // desc → asc
    await expect.poll(() => firstRowText(page)).toContain(row(1));
  });

  test('navigates to the new-motivo page', async ({ page }) => {
    await page.goto('/motivos-incidente');
    await page.getByRole('link', { name: 'Novo motivo' }).click();
    await expect(page).toHaveURL(/\/motivos-incidente\/novo$/);
    await expect(page.getByRole('heading', { name: 'Novo motivo de incidente' })).toBeVisible();
  });

  test('creates a new motivo', async ({ page }) => {
    const nome = `${prefix}-novo`;
    await page.goto('/motivos-incidente/novo');
    await fillField(page, 'Nome', nome);
    await clickSave(page, 'Criar');
    await page.waitForURL(
      (url) =>
        /^\/motivos-incidente\/[^/]+$/.test(url.pathname) &&
        url.pathname !== '/motivos-incidente/novo',
      { timeout: 15_000 },
    );
    await expect
      .poll(() => docExistsByName('motivosincidentes', nome), {
        timeout: 15_000,
      })
      .toBe(true);

    await page.goto('/motivos-incidente');
    await applyTextFilter(page, 'Nome', nome);
    await expectRowVisible(page, nome);
  });

  test('rejects creating a motivo without a Nome (required field)', async ({ page }) => {
    await page.goto('/motivos-incidente/novo');
    await clickSave(page, 'Criar');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/motivos-incidente\/novo$/);
  });

  test('opens an existing motivo from the list', async ({ page }) => {
    await page.goto('/motivos-incidente');
    await applyTextFilter(page, 'Nome', row(2));
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/motivos-incidente\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('warns about unsaved changes when leaving the edit page', async ({ page }) => {
    await page.goto(`/motivos-incidente/${row(4)}`);
    await fillField(page, 'Nome', `${prefix}-004-edicao-nao-salva`);

    let dialogSeen = false;
    page.once('dialog', (d) => {
      dialogSeen = true;
      void d.dismiss();
    });
    await page.getByRole('link', { name: 'Voltar à lista' }).click();
    await expect.poll(() => dialogSeen).toBe(true);
    await expect(page).toHaveURL(/\/motivos-incidente\/[^/]+$/);
  });

  test('edits a motivo and saves', async ({ page }) => {
    await page.goto(`/motivos-incidente/${row(5)}`);
    await fillField(page, 'Nome', `${prefix}-005-editado`);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/motivos-incidente$/, { timeout: 15_000 });

    await page.goto(`/motivos-incidente/${row(5)}`);
    await expectFieldAfterReload(page, 'Nome', `${prefix}-005-editado`);
  });

  test('edits a motivo and continues editing', async ({ page }) => {
    await page.goto(`/motivos-incidente/${row(6)}`);
    await fillField(page, 'Nome', `${prefix}-006-continua`);
    await clickSaveAndContinue(page);
    await expectToast(page, /Salvo/);
    await expect(page).toHaveURL(/\/motivos-incidente\/[^/]+$/);
  });

  test('rejects editing a motivo with an empty Nome', async ({ page }) => {
    await page.goto(`/motivos-incidente/${row(1)}`);
    await fillField(page, 'Nome', '');
    await clickSave(page, 'Salvar alterações');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/motivos-incidente\/[^/]+$/);
  });

  test('deletes a motivo through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/motivos-incidente/${row(7)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/motivos-incidente$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', row(7));
    await expectEmptyState(page);
  });

  test('keeps column filters in the URL query string', async ({ page }) => {
    await page.goto('/motivos-incidente');
    await applyTextFilter(page, 'Nome', row(2));
    await expect(page).toHaveURL(/nome=contains%3A/);

    await page.reload();
    await expectRowVisible(page, row(2));
    await expectRowHidden(page, row(1));

    await clearColumnFilter(page, 'Nome');
    await expect(page).not.toHaveURL(/nome=contains/);
  });

  test('keeps the sort in the URL and persists hidden columns', async ({ page }) => {
    await page.goto('/motivos-incidente');
    await clickColumnSort(page, 'Ativo');
    await expect(page).toHaveURL(/sort=ativo%3A/);

    await page.getByRole('button', { name: 'Configurar colunas' }).click();
    await page.getByRole('checkbox', { name: 'Ativo' }).uncheck();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByRole('columnheader', { name: /Ativo/ })).toHaveCount(0);
  });
});
