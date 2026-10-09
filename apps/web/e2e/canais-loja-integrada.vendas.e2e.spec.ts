import { expect, test } from '@playwright/test';
import {
  cleanupLojaIntegradaFixtures,
  docExistsByName,
  e2ePrefix,
  seedLojaIntegradaFixtures,
  seedShopeeFixtures,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowHidden, expectRowVisible } from './helpers/table-view';
import {
  clickSave,
  confirmDelete,
  expectFieldAfterReload,
  fillField,
  selectFieldWithSearch,
} from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/canais/loja-integrada` TableView + ObjectView
 * flow, driven by `integracaoSchema` filtered to `tipo == 3` (Loja Integrada).
 * Mirrors the Shopee suite; row lookup leans on the run-scoped `nome` prefix.
 *
 * The `apps/loja-integrada` backend does NOT run in this suite, and this screen
 * never talks to it: it registers the conta in Firestore and nothing else.
 */
test.describe.serial('Canais Loja Integrada e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('lji');
  // A second prefix for the near-miss conta of ANOTHER channel. The seed writes
  // `<prefix>-NNN` whatever the tipo, so reusing `prefix` would overwrite an LI
  // row instead of adding a Shopee one. `cleanupLojaIntegradaFixtures(prefix)`
  // still sweeps it: the cleanup is by name prefix, not by tipo.
  const outroPrefix = `${prefix}-outro`;
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;
  const refLabel = `${prefix}-ref`;

  test.beforeAll(async ({ browser }) => {
    // Compiling 3 cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedLojaIntegradaFixtures(prefix, 5),
      seedShopeeFixtures(outroPrefix, 1),
      warmRoutes(browser, [
        '/canais/loja-integrada',
        '/canais/loja-integrada/novo',
        '/canais/loja-integrada/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupLojaIntegradaFixtures(prefix);
  });

  test('TableView lists Loja Integrada contas only', async ({ page }) => {
    await page.goto('/canais/loja-integrada');
    await expect(page.getByRole('heading', { name: 'Loja Integrada' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
    // Narrow to this run first: the list is `orderBy nome asc` with `limit: 50`,
    // so a run-scoped name is only findable while it stays on page 1 (#712).
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(1));
    await expectRowVisible(page, row(5));
    // The near-miss: a tipo-5 conta whose name matches the same filter is NOT
    // in this channel's slice.
    await expectRowHidden(page, `${outroPrefix}-001`);
  });

  test('says honestly that the screen only registers the conta', async ({ page }) => {
    await page.goto('/canais/loja-integrada');
    await expect(page.getByText('O que esta tela faz hoje')).toBeVisible();
    await expect(page.getByText('nada é sincronizado', { exact: false })).toBeVisible();
  });

  test('navigates to the new-conta page', async ({ page }) => {
    await page.goto('/canais/loja-integrada');
    await page.getByRole('link', { name: 'Nova conta' }).click();
    await expect(page).toHaveURL(/\/canais\/loja-integrada\/novo$/);
    await expect(page.getByRole('heading', { name: 'Nova conta Loja Integrada' })).toBeVisible();
  });

  test('creates a new conta and lands on its edit page', async ({ page }) => {
    const nome = `${prefix}-nova`;
    await page.goto('/canais/loja-integrada/novo');
    await fillField(page, 'Nome', nome);
    // The dropdowns cap at 15 docs: type to trigger the server-side search so
    // the run-scoped fixture refs are found regardless of their position.
    await selectFieldWithSearch(page, 'Filial', `${refLabel}-filial`);
    await selectFieldWithSearch(page, 'Tabela de preços', `${refLabel}-lista`);
    await selectFieldWithSearch(page, 'Depósito', `${refLabel}-deposito`);
    await clickSave(page, 'Criar');

    // onSaved does router.replace('/canais/loja-integrada/<id>').
    await page.waitForURL(
      (url) =>
        /^\/canais\/loja-integrada\/[^/]+$/.test(url.pathname) &&
        url.pathname !== '/canais/loja-integrada/novo',
      { timeout: 15_000 },
    );
    await expect.poll(() => docExistsByName('integracao', nome), { timeout: 15_000 }).toBe(true);
    await expect(page.getByRole('heading', { name: 'Conta Loja Integrada' })).toBeVisible();

    await page.goto('/canais/loja-integrada');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, nome);
  });

  test('opens an existing conta from the list', async ({ page }) => {
    await page.goto('/canais/loja-integrada');
    await applyTextFilter(page, 'Nome', prefix);
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/canais\/loja-integrada\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('edits a conta and saves', async ({ page }) => {
    await page.goto(`/canais/loja-integrada/${row(4)}`);
    await fillField(page, 'Nome', `${prefix}-004-editada`);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/canais\/loja-integrada$/, { timeout: 15_000 });

    await page.goto(`/canais/loja-integrada/${row(4)}`);
    await expectFieldAfterReload(page, 'Nome', `${prefix}-004-editada`);
  });

  test('deletes a conta through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/canais/loja-integrada/${row(5)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/canais\/loja-integrada$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowHidden(page, row(5));
  });
});
