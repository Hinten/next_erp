import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  docExistsByName,
  e2ePrefix,
  seedBandeirasCartao,
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
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/bandeiras-cartao` TableView + ObjectView
 * flow, driven by `bandeiraCartaoSchema`. Seeds 7 mock bandeiras (Admin SDK),
 * then exercises listing, per-column filtering (text + enum + boolean),
 * sorting, create/edit/delete, schema-validation feedback (`nome` is
 * required), the unsaved-changes guard and URL query-param persistence.
 * Runs serially.
 */
test.describe.serial('Bandeiras de cartão e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('ban');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async ({ browser }) => {
    // Compiling 3 cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedBandeirasCartao(prefix, 7),
      warmRoutes(browser, [
        '/bandeiras-cartao',
        '/bandeiras-cartao/novo',
        '/bandeiras-cartao/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('bandeirasCartao', prefix);
  });

  test('TableView query works without a filter', async ({ page }) => {
    await page.goto('/bandeiras-cartao');
    await expect(
      page.getByRole('heading', { name: 'Bandeiras de cartão' }),
    ).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('filters rows by the Nome (text), Bandeira (enum) and Cartão de crédito (boolean) columns', async ({
    page,
  }) => {
    await page.goto('/bandeiras-cartao');
    await applyTextFilter(page, 'Nome', row(3));
    await expectRowVisible(page, row(3));
    await expectRowHidden(page, row(1));
    await clearColumnFilter(page, 'Nome');

    // Seeded bandeira cycles Mastercard/Elo/Visa → Visa at i=3,6.
    await applyTextFilter(page, 'Nome', prefix);
    await applySelectFilter(page, 'Bandeira', 'Visa');
    await expectRowVisible(page, row(3));
    await expectRowHidden(page, row(1));
    await clearColumnFilter(page, 'Bandeira');

    // Seeded ehCredito = (i % 2 === 0) → true at i=2,4,6.
    await applySelectFilter(page, 'Cartão de crédito', 'Sim');
    await expectRowVisible(page, row(2));
    await expectRowHidden(page, row(1));
  });

  test('shows the empty state when a filter matches nothing', async ({ page }) => {
    await page.goto('/bandeiras-cartao');
    await applyTextFilter(page, 'Nome', `${prefix}-sem-correspondencia`);
    await expectEmptyState(page);
  });

  test('sorts rows by clicking the Nome column header', async ({ page }) => {
    await page.goto('/bandeiras-cartao');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(1));
    await expect.poll(() => firstRowText(page)).toContain(row(1));

    await clickColumnSort(page, 'Nome'); // asc → desc
    await expect(page).toHaveURL(/sort=nome%3Adesc/);
    await expect.poll(() => firstRowText(page)).toContain(row(7));

    await clickColumnSort(page, 'Nome'); // desc → asc
    await expect.poll(() => firstRowText(page)).toContain(row(1));
  });

  test('navigates to the new-bandeira page', async ({ page }) => {
    await page.goto('/bandeiras-cartao');
    await page.getByRole('link', { name: 'Nova bandeira' }).click();
    await expect(page).toHaveURL(/\/bandeiras-cartao\/novo$/);
    await expect(
      page.getByRole('heading', { name: 'Nova bandeira de cartão' }),
    ).toBeVisible();
  });

  test('creates a new bandeira', async ({ page }) => {
    const nome = `${prefix}-novo`;
    await page.goto('/bandeiras-cartao/novo');
    await fillField(page, 'Nome', nome);
    await clickSave(page, 'Criar');
    await page.waitForURL(
      (url) =>
        /^\/bandeiras-cartao\/[^/]+$/.test(url.pathname) &&
        url.pathname !== '/bandeiras-cartao/novo',
      { timeout: 15_000 },
    );
    await expect
      .poll(() => docExistsByName('bandeirasCartao', nome), { timeout: 15_000 })
      .toBe(true);

    await page.goto('/bandeiras-cartao');
    await applyTextFilter(page, 'Nome', nome);
    await expectRowVisible(page, nome);
  });

  test('rejects creating a bandeira without a Nome (required field)', async ({
    page,
  }) => {
    await page.goto('/bandeiras-cartao/novo');
    await clickSave(page, 'Criar');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/bandeiras-cartao\/novo$/);
  });

  test('opens an existing bandeira from the list', async ({ page }) => {
    await page.goto('/bandeiras-cartao');
    await applyTextFilter(page, 'Nome', row(2));
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/bandeiras-cartao\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('warns about unsaved changes when leaving the edit page', async ({
    page,
  }) => {
    await page.goto(`/bandeiras-cartao/${row(4)}`);
    await fillField(page, 'CNPJ da instituição', '11222333000181');

    let dialogSeen = false;
    page.once('dialog', (d) => {
      dialogSeen = true;
      void d.dismiss();
    });
    await page.getByRole('link', { name: 'Voltar à lista' }).click();
    await expect.poll(() => dialogSeen).toBe(true);
    await expect(page).toHaveURL(/\/bandeiras-cartao\/[^/]+$/);
  });

  test('edits a bandeira and saves', async ({ page }) => {
    await page.goto(`/bandeiras-cartao/${row(5)}`);
    await fillField(page, 'CNPJ da instituição', '12345678000199');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/bandeiras-cartao$/, { timeout: 15_000 });

    await page.goto(`/bandeiras-cartao/${row(5)}`);
    await expect(
      page.getByLabel('CNPJ da instituição', { exact: true }),
    ).toHaveValue('12345678000199');
  });

  test('edits a bandeira and continues editing', async ({ page }) => {
    await page.goto(`/bandeiras-cartao/${row(6)}`);
    await fillField(page, 'CNPJ da instituição', '99888777000166');
    await clickSaveAndContinue(page);
    await expectToast(page, /Salvo/);
    await expect(page).toHaveURL(/\/bandeiras-cartao\/[^/]+$/);
  });

  test('rejects editing a bandeira with an empty Nome', async ({ page }) => {
    await page.goto(`/bandeiras-cartao/${row(1)}`);
    await fillField(page, 'Nome', '');
    await clickSave(page, 'Salvar alterações');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/bandeiras-cartao\/[^/]+$/);
  });

  test('deletes a bandeira through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/bandeiras-cartao/${row(7)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/bandeiras-cartao$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', row(7));
    await expectEmptyState(page);
  });

  test('keeps column filters in the URL query string', async ({ page }) => {
    await page.goto('/bandeiras-cartao');
    await applyTextFilter(page, 'Nome', row(2));
    await expect(page).toHaveURL(/nome=contains%3A/);

    await page.reload();
    await expectRowVisible(page, row(2));
    await expectRowHidden(page, row(1));

    await clearColumnFilter(page, 'Nome');
    await expect(page).not.toHaveURL(/nome=contains/);
  });

  test('keeps the sort in the URL and persists hidden columns', async ({
    page,
  }) => {
    await page.goto('/bandeiras-cartao');
    await clickColumnSort(page, 'Bandeira');
    await expect(page).toHaveURL(/sort=bandeira%3A/);

    await page.getByRole('button', { name: 'Configurar colunas' }).click();
    await page.getByRole('checkbox', { name: 'Bandeira' }).uncheck();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(
      page.getByRole('columnheader', { name: /Bandeira/ }),
    ).toHaveCount(0);
  });
});
