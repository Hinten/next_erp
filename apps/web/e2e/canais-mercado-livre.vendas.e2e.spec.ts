import { expect, test } from '@playwright/test';
import {
  cleanupMercadoLivreFixtures,
  docExistsByName,
  e2ePrefix,
  seedMercadoLivreFixtures,
} from './_helpers/seed-data';
import { expectRowHidden, expectRowVisible } from './helpers/table-view';
import { clickSave, confirmDelete, fillField, selectFieldWithSearch } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/canais/mercado-livre` TableView + ObjectView
 * flow, driven by `integracaoSchema` filtered to `tipo == 1` (mercadoLivre).
 * Mirrors the Balcão suite; row lookup leans on the run-scoped `nome` prefix.
 * The Conta panel talks to the apps/mercado-livre backend, which does NOT run
 * in this suite — the assertions only require it to degrade gracefully
 * ("Não conectada" + error alert), never to connect.
 */
test.describe.serial('Canais Mercado Livre e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('ml');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;
  const refLabel = `${prefix}-ref`;

  test.beforeAll(async ({ browser }) => {
    // Compiling 3 cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedMercadoLivreFixtures(prefix, 5),
      warmRoutes(browser, [
        '/canais/mercado-livre',
        '/canais/mercado-livre/novo',
        '/canais/mercado-livre/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupMercadoLivreFixtures(prefix);
  });

  test('TableView lists Mercado Livre accounts only', async ({ page }) => {
    await page.goto('/canais/mercado-livre');
    await expect(page.getByRole('heading', { name: 'Mercado Livre' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
    await expectRowVisible(page, row(1));
    await expectRowVisible(page, row(5));
  });

  test('navigates to the new-conta page', async ({ page }) => {
    await page.goto('/canais/mercado-livre');
    await page.getByRole('link', { name: 'Nova conta' }).click();
    await expect(page).toHaveURL(/\/canais\/mercado-livre\/novo$/);
    await expect(page.getByRole('heading', { name: 'Nova conta Mercado Livre' })).toBeVisible();
  });

  test('creates a new conta and lands on the connect panel', async ({ page }) => {
    const nome = `${prefix}-nova`;
    await page.goto('/canais/mercado-livre/novo');
    await fillField(page, 'Nome', nome);
    // The dropdowns cap at 15 docs — type to trigger the server-side search
    // so the run-scoped fixture refs are found regardless of their position.
    await selectFieldWithSearch(page, 'Filial', `${refLabel}-filial`);
    await selectFieldWithSearch(page, 'Tabela de preços', `${refLabel}-lista`);
    await selectFieldWithSearch(page, 'Depósito', `${refLabel}-deposito`);
    await clickSave(page, 'Criar');

    // onSaved does router.replace('/canais/mercado-livre/<id>') — the edit
    // page, where the Conectar panel lives.
    await page.waitForURL(
      (url) =>
        /^\/canais\/mercado-livre\/[^/]+$/.test(url.pathname) &&
        url.pathname !== '/canais/mercado-livre/novo',
      { timeout: 15_000 },
    );
    await expect.poll(() => docExistsByName('integracao', nome), { timeout: 15_000 }).toBe(true);

    // The account panel renders even with the mercado-livre backend offline —
    // a disconnected badge + the Conectar button (it must degrade, not break).
    await expect(page.getByText('Conta Mercado Livre')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Conectar conta' })).toBeVisible({
      timeout: 15_000,
    });

    await page.goto('/canais/mercado-livre');
    await expectRowVisible(page, nome);
  });

  test('opens an existing conta from the list', async ({ page }) => {
    await page.goto('/canais/mercado-livre');
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/canais\/mercado-livre\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('edits a conta and saves', async ({ page }) => {
    await page.goto(`/canais/mercado-livre/${row(4)}`);
    await fillField(page, 'Nome', `${prefix}-004-editada`);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/canais\/mercado-livre$/, { timeout: 15_000 });

    await page.goto(`/canais/mercado-livre/${row(4)}`);
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(`${prefix}-004-editada`);
  });

  test('deletes a conta through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/canais/mercado-livre/${row(5)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/canais\/mercado-livre$/, { timeout: 15_000 });
    await expectRowHidden(page, row(5));
  });
});
