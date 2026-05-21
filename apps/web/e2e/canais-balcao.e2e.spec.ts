import { expect, test } from '@playwright/test';
import {
  cleanupBalcaoFixtures,
  docExistsByName,
  e2ePrefix,
  seedBalcaoFixtures,
} from './_helpers/seed-data';
import {
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
  confirmDelete,
  fillField,
  selectField,
} from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/canais/balcao` TableView + ObjectView flow,
 * driven by `integracaoSchema` filtered to `tipo == 7` (balcao). The form
 * exposes the Balcão subset of fields plus four `<CollectionSelect>` ref
 * pickers — the suite seeds one filial, one listaDePrecos and one deposito
 * up front so the create flow has something to pick.
 */
test.describe.serial('Canais Balcão e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('bal');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;
  const refLabel = `${prefix}-ref`;

  test.beforeAll(async ({ browser }) => {
    // Compiling 3 cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedBalcaoFixtures(prefix, 5),
      warmRoutes(browser, [
        '/canais/balcao',
        '/canais/balcao/novo',
        '/canais/balcao/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupBalcaoFixtures(prefix);
  });

  test('TableView lists Balcão channels only', async ({ page }) => {
    await page.goto('/canais/balcao');
    await expect(page.getByRole('heading', { name: 'Balcão' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(1));
  });

  test('filters rows by Nome', async ({ page }) => {
    await page.goto('/canais/balcao');
    await applyTextFilter(page, 'Nome', row(3));
    await expectRowVisible(page, row(3));
    await expectRowHidden(page, row(1));
    await clearColumnFilter(page, 'Nome');
  });

  test('shows the empty state when a filter matches nothing', async ({ page }) => {
    await page.goto('/canais/balcao');
    await applyTextFilter(page, 'Nome', `${prefix}-sem-correspondencia`);
    await expectEmptyState(page);
  });

  test('sorts rows by clicking the Nome column header', async ({ page }) => {
    await page.goto('/canais/balcao');
    await applyTextFilter(page, 'Nome', prefix);
    await expect.poll(() => firstRowText(page)).toContain(row(1));

    await clickColumnSort(page, 'Nome'); // asc → desc
    await expect(page).toHaveURL(/sort=nome%3Adesc/);
    await expect.poll(() => firstRowText(page)).toContain(row(5));
  });

  test('navigates to the new-balcao page', async ({ page }) => {
    await page.goto('/canais/balcao');
    await page.getByRole('link', { name: 'Novo balcão' }).click();
    await expect(page).toHaveURL(/\/canais\/balcao\/novo$/);
    await expect(
      page.getByRole('heading', { name: 'Novo balcão' }),
    ).toBeVisible();
  });

  test('creates a new balcao', async ({ page }) => {
    const nome = `${prefix}-novo`;
    await page.goto('/canais/balcao/novo');
    await fillField(page, 'Nome', nome);
    await selectField(page, 'Filial', `${refLabel}-filial`);
    await selectField(page, 'Tabela de preços', `${refLabel}-lista`);
    await selectField(page, 'Depósito', `${refLabel}-deposito`);
    await clickSave(page, 'Criar');

    // onSaved does router.replace('/canais/balcao/<id>').
    await page.waitForURL(
      (url) =>
        /^\/canais\/balcao\/[^/]+$/.test(url.pathname) &&
        url.pathname !== '/canais/balcao/novo',
      { timeout: 15_000 },
    );
    await expect
      .poll(() => docExistsByName('integracao', nome), { timeout: 15_000 })
      .toBe(true);

    await page.goto('/canais/balcao');
    await applyTextFilter(page, 'Nome', nome);
    await expectRowVisible(page, nome);
  });

  test('opens an existing balcao from the list', async ({ page }) => {
    await page.goto('/canais/balcao');
    await applyTextFilter(page, 'Nome', row(2));
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/canais\/balcao\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('edits a balcao and saves', async ({ page }) => {
    await page.goto(`/canais/balcao/${row(4)}`);
    await fillField(page, 'Nome', `${prefix}-004-editado`);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/canais\/balcao$/, { timeout: 15_000 });

    await page.goto(`/canais/balcao/${row(4)}`);
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(
      `${prefix}-004-editado`,
    );
  });

  test('deletes a balcao through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/canais/balcao/${row(5)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/canais\/balcao$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', row(5));
    await expectEmptyState(page);
  });
});
