import { expect, test } from '@playwright/test';
import {
  cleanupShopeeFixtures,
  docExistsByName,
  e2ePrefix,
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
 * End-to-end coverage for the `/canais/shopee` TableView + ObjectView flow,
 * driven by `integracaoSchema` filtered to `tipo == 5` (shopee). Mirrors the
 * Mercado Livre suite; row lookup leans on the run-scoped `nome` prefix.
 *
 * The `apps/shopee` backend does NOT run in this suite — the `ContaShopeePanel`
 * (`/canais/shopee/[id]`) talks to it. The assertion only requires the panel to
 * degrade gracefully (a disconnected state + the Conectar button), never to
 * reach the backend, and `shop_id` is asserted read-only regardless of whether
 * the conta read succeeds — that field is disabled by `FieldConfig.editable`,
 * not by the backend answering.
 */
test.describe.serial('Canais Shopee e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('shp');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;
  const refLabel = `${prefix}-ref`;

  test.beforeAll(async ({ browser }) => {
    // Compiling 3 cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedShopeeFixtures(prefix, 5),
      warmRoutes(browser, [
        '/canais/shopee',
        '/canais/shopee/novo',
        '/canais/shopee/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupShopeeFixtures(prefix);
  });

  test('TableView lists Shopee accounts only', async ({ page }) => {
    await page.goto('/canais/shopee');
    await expect(page.getByRole('heading', { name: 'Shopee' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
    // Narrow to this run first: the list is `orderBy nome asc` with `limit: 50`,
    // so a run-scoped name is only findable while it stays on page 1 — which
    // orphaned fixtures from older runs quietly prevent (#712).
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(1));
    await expectRowVisible(page, row(5));
  });

  test('navigates to the new-conta page', async ({ page }) => {
    await page.goto('/canais/shopee');
    await page.getByRole('link', { name: 'Nova conta' }).click();
    await expect(page).toHaveURL(/\/canais\/shopee\/novo$/);
    await expect(page.getByRole('heading', { name: 'Nova conta Shopee' })).toBeVisible();
  });

  test('creates a new conta and lands on the connect panel', async ({ page }) => {
    const nome = `${prefix}-nova`;
    await page.goto('/canais/shopee/novo');
    await fillField(page, 'Nome', nome);
    // The dropdowns cap at 15 docs — type to trigger the server-side search
    // so the run-scoped fixture refs are found regardless of their position.
    await selectFieldWithSearch(page, 'Filial', `${refLabel}-filial`);
    await selectFieldWithSearch(page, 'Tabela de preços', `${refLabel}-lista`);
    await selectFieldWithSearch(page, 'Depósito', `${refLabel}-deposito`);
    await clickSave(page, 'Criar');

    // onSaved does router.replace('/canais/shopee/<id>') — the edit page,
    // where the Conectar panel lives.
    await page.waitForURL(
      (url) =>
        /^\/canais\/shopee\/[^/]+$/.test(url.pathname) && url.pathname !== '/canais/shopee/novo',
      { timeout: 15_000 },
    );
    await expect.poll(() => docExistsByName('integracao', nome), { timeout: 15_000 }).toBe(true);

    // The account panel renders even with the shopee backend offline — a
    // disconnected state + the Conectar button (it must degrade, not break).
    // `ConnectionPanel`'s own title is a `<Text>`, never a heading, precisely so
    // this locator stays unambiguous against the page's own `<Title order={2}>`
    // carrying the same words.
    await expect(page.getByRole('heading', { name: 'Conta Shopee' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Conectar conta' })).toBeVisible({
      timeout: 15_000,
    });

    await page.goto('/canais/shopee');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, nome);
  });

  test('opens an existing conta from the list', async ({ page }) => {
    await page.goto('/canais/shopee');
    await applyTextFilter(page, 'Nome', prefix);
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/canais\/shopee\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('shows shop_id and main_account_id as read-only, callback-written fields', async ({
    page,
  }) => {
    await page.goto(`/canais/shopee/${row(3)}`);
    await expect(page.getByLabel('Shop ID', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('Main Account ID', { exact: true })).toBeDisabled();
  });

  test('edits a conta and saves', async ({ page }) => {
    await page.goto(`/canais/shopee/${row(4)}`);
    await fillField(page, 'Nome', `${prefix}-004-editada`);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/canais\/shopee$/, { timeout: 15_000 });

    await page.goto(`/canais/shopee/${row(4)}`);
    await expectFieldAfterReload(page, 'Nome', `${prefix}-004-editada`);
  });

  test('deletes a conta through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/canais/shopee/${row(5)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/canais\/shopee$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowHidden(page, row(5));
  });
});
