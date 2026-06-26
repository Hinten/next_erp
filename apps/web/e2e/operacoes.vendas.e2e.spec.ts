import { expect, test } from '@playwright/test';
import {
  cleanupOperacoes,
  docExistsByName,
  e2ePrefix,
  getOperacaoByName,
  seedOperacoes,
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
import { clickSave, confirmDelete, expectFieldError, fillField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/operacoes` (operação fiscal) TableView +
 * ObjectView flow, driven by `operacaoSchema`. Seeds 7 mock operações
 * (Admin SDK), then exercises listing, text filtering, sorting,
 * create/edit/delete, the required-field feedback (`nome` /
 * `naturezaDaOperacao`), the three-tab editor layout and the "save first"
 * gate on the Regras de imposto tab. The deep tax editor itself is covered by
 * the schema/resolver unit tests. Runs serially.
 */
test.describe.serial('Operações e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('op');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await Promise.all([
      seedOperacoes(prefix, 7),
      warmRoutes(browser, ['/operacoes', '/operacoes/novo', '/operacoes/__aquecimento__']),
    ]);
  });

  test.afterAll(async () => {
    await cleanupOperacoes(prefix);
  });

  test('TableView query works without a filter', async ({ page }) => {
    await page.goto('/operacoes');
    await expect(page.getByRole('heading', { name: 'Operações fiscais' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('filters rows by the Nome (text) column', async ({ page }) => {
    await page.goto('/operacoes');
    await applyTextFilter(page, 'Nome', row(3));
    await expectRowVisible(page, row(3));
    await expectRowHidden(page, row(1));
    await clearColumnFilter(page, 'Nome');
  });

  test('shows the empty state when a filter matches nothing', async ({ page }) => {
    await page.goto('/operacoes');
    await applyTextFilter(page, 'Nome', `${prefix}-sem-correspondencia`);
    await expectEmptyState(page);
  });

  test('sorts rows by clicking the Nome column header', async ({ page }) => {
    await page.goto('/operacoes');
    await applyTextFilter(page, 'Nome', prefix);
    await expect.poll(() => firstRowText(page)).toContain(row(1));

    await clickColumnSort(page, 'Nome'); // asc → desc
    await expect(page).toHaveURL(/sort=nome%3Adesc/);
    await expect.poll(() => firstRowText(page)).toContain(row(7));

    await clickColumnSort(page, 'Nome'); // desc → asc
    await expect.poll(() => firstRowText(page)).toContain(row(1));
  });

  test('navigates to the new-operação page', async ({ page }) => {
    await page.goto('/operacoes');
    await page.getByRole('link', { name: 'Nova operação' }).click();
    await expect(page).toHaveURL(/\/operacoes\/novo$/);
    await expect(page.getByRole('heading', { name: 'Nova operação fiscal' })).toBeVisible();
  });

  test('the create form has the Dados gerais / Impostos / Regras tabs', async ({ page }) => {
    await page.goto('/operacoes/novo');
    await expect(page.getByRole('tab', { name: 'Dados gerais' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Impostos (padrão)' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Regras de imposto' })).toBeVisible();
  });

  test('the Regras de imposto tab asks to save the operação first', async ({ page }) => {
    await page.goto('/operacoes/novo');
    await page.getByRole('tab', { name: 'Regras de imposto' }).click();
    await expect(page.getByText(/Salve a operação para cadastrar regras/)).toBeVisible();
  });

  test('creates a new operação', async ({ page }) => {
    const nome = `${prefix}-novo`;
    await page.goto('/operacoes/novo');
    await fillField(page, 'Nome', nome);
    await fillField(page, 'Natureza da operação', 'Venda de mercadoria');
    await clickSave(page, 'Criar');
    await page.waitForURL(
      (url) => /^\/operacoes\/[^/]+$/.test(url.pathname) && url.pathname !== '/operacoes/novo',
      { timeout: 15_000 },
    );
    await expect.poll(() => docExistsByName('operacao', nome), { timeout: 15_000 }).toBe(true);

    await page.goto('/operacoes');
    await applyTextFilter(page, 'Nome', nome);
    await expectRowVisible(page, nome);
  });

  test('rejects creating an operação without a Nome (required field)', async ({ page }) => {
    await page.goto('/operacoes/novo');
    await fillField(page, 'Natureza da operação', 'Sem nome');
    await clickSave(page, 'Criar');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/operacoes\/novo$/);
  });

  test('opens an existing operação and edits its Natureza', async ({ page }) => {
    await page.goto(`/operacoes/${row(2)}`);
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
    await fillField(page, 'Natureza da operação', 'Natureza editada');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/operacoes$/, { timeout: 15_000 });
    await expect
      .poll(async () => (await getOperacaoByName(row(2)))?.naturezaDaOperacao, { timeout: 15_000 })
      .toBe('Natureza editada');
  });

  test('deletes an operação through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/operacoes/${row(7)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/operacoes$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', row(7));
    await expectEmptyState(page);
  });
});
