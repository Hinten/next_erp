import { expect, test } from '@playwright/test';
import { cleanupByNamePrefix, docExistsByName, e2ePrefix } from './_helpers/seed-data';
import { applyTextFilter, expectRowVisible } from './helpers/table-view';
import { clickSave, expectFieldError, fillField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/variacoes` (grupoDeVariacoes) TableView +
 * ObjectView flow: listing, creating a group, required-field validation, and
 * the embedded VarianteEditor on the "Variantes" tab. Guards the
 * `grupoDeVariacoesSchema` CRUD wiring + the `deriveOnSave` (variacoesIds)
 * hook against regressions. Runs serially.
 */
test.describe.serial('Variações e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('grp');
  const nome = `${prefix}-001`;

  test.beforeAll(async ({ browser }) => {
    // Cold-compiling the list + create + editor routes can outlast the budget.
    test.setTimeout(240_000);
    await warmRoutes(browser, ['/variacoes', '/variacoes/novo', '/variacoes/__aquecimento__']);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('grupoDeVariacoes', prefix);
  });

  test('TableView renders the list', async ({ page }) => {
    await page.goto('/variacoes');
    await expect(page.getByRole('heading', { name: 'Variações' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('creates a grupo de variação', async ({ page }) => {
    await page.goto('/variacoes/novo');
    await expect(page.getByRole('heading', { name: 'Novo grupo de variação' })).toBeVisible();
    await fillField(page, 'Nome', nome);
    await clickSave(page, 'Criar');

    // onSaved → router.replace('/variacoes/<id>'). Match the detail route
    // explicitly so it can't resolve against the /variacoes/novo we start on.
    await page.waitForURL(
      (url) => /^\/variacoes\/[^/]+$/.test(url.pathname) && url.pathname !== '/variacoes/novo',
      { timeout: 15_000 },
    );
    await expect
      .poll(() => docExistsByName('grupoDeVariacoes', nome), { timeout: 15_000 })
      .toBe(true);

    await page.goto('/variacoes');
    await applyTextFilter(page, 'Nome', nome);
    await expectRowVisible(page, nome);
  });

  test('rejects creating a grupo without a Nome (required field)', async ({ page }) => {
    await page.goto('/variacoes/novo');
    await clickSave(page, 'Criar');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/variacoes\/novo$/);
  });

  test('adds a variante row on the Variantes tab', async ({ page }) => {
    await page.goto('/variacoes');
    await applyTextFilter(page, 'Nome', nome);
    await page.getByRole('row', { name: new RegExp(nome) }).click();
    await page.waitForURL(/\/variacoes\/[^/]+$/, { timeout: 10_000 });

    await page.getByRole('tab', { name: 'Variantes' }).click();
    await expect(page.getByText('Nenhuma variante.', { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Adicionar variante' }).click();
    // A new row appears with its own remove affordance (unambiguous, unlike the
    // duplicate "Nome" label shared with the group's own field).
    await expect(page.getByRole('button', { name: 'Remover variante' })).toBeVisible();
  });
});
