import { type Page, expect, test } from '@playwright/test';
import {
  cleanupByFieldPrefix,
  docExistsByField,
  e2ePrefix,
  seedFiliais,
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
  expectFieldError,
  fillField,
  selectField,
} from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/configuracoes/filiais` TableView + ObjectView
 * flow, driven by the `filialSchema`. Exercises listing, per-column
 * filtering, sorting, create/edit/delete, the nested `sede` (endereço)
 * fieldset, schema-validation feedback, the unsaved-changes guard, URL
 * query-param persistence and the placeholder tabs. Runs serially — later
 * steps consume earlier state.
 */
test.describe.serial('Filiais e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('fil');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  /** Fill the required `sede` (endereço) fieldset of the create form. */
  async function fillSede(page: Page): Promise<void> {
    await fillField(page, 'Logradouro', 'Av. Paulista');
    await fillField(page, 'Número', '1000');
    await fillField(page, 'Bairro', 'Bela Vista');
    await fillField(page, 'CEP', '01310100');
    await fillField(page, 'Cidade', 'São Paulo');
    await selectField(page, 'Estado (UF)', 'SP');
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await Promise.all([
      seedFiliais(prefix, 7),
      warmRoutes(browser, [
        '/configuracoes/filiais',
        '/configuracoes/filiais/novo',
        '/configuracoes/filiais/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupByFieldPrefix('filiais', 'razaoSocial', prefix);
  });

  test('TableView query works without a filter', async ({ page }) => {
    await page.goto('/configuracoes/filiais');
    await expect(page.getByRole('heading', { name: 'Filiais' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('filters rows by the Razão Social column', async ({ page }) => {
    await page.goto('/configuracoes/filiais');
    await applyTextFilter(page, 'Razão Social', row(3));
    await expectRowVisible(page, row(3));
    await expectRowHidden(page, row(1));
    await clearColumnFilter(page, 'Razão Social');
  });

  test('shows the empty state when a filter matches nothing', async ({ page }) => {
    await page.goto('/configuracoes/filiais');
    await applyTextFilter(page, 'Razão Social', `${prefix}-sem-correspondencia`);
    await expectEmptyState(page);
  });

  test('sorts rows by clicking the Razão Social column header', async ({ page }) => {
    await page.goto('/configuracoes/filiais');
    await applyTextFilter(page, 'Razão Social', prefix);
    await expectRowVisible(page, row(1));
    await expect.poll(() => firstRowText(page)).toContain(row(1));

    await clickColumnSort(page, 'Razão Social'); // asc → desc
    await expect(page).toHaveURL(/sort=razaoSocial%3Adesc/);
    await expect.poll(() => firstRowText(page)).toContain(row(7));

    await clickColumnSort(page, 'Razão Social'); // desc → asc
    await expect.poll(() => firstRowText(page)).toContain(row(1));
  });

  test('navigates to the new-filial page', async ({ page }) => {
    await page.goto('/configuracoes/filiais');
    await page.getByRole('link', { name: 'Nova filial' }).click();
    await expect(page).toHaveURL(/\/configuracoes\/filiais\/novo$/);
    await expect(page.getByRole('heading', { name: 'Nova filial' })).toBeVisible();
  });

  test('shows placeholder tabs on the new-filial page', async ({ page }) => {
    await page.goto('/configuracoes/filiais/novo');
    await page.getByRole('tab', { name: 'Configurações NFe' }).click();
    await expect(page.getByText(/configuração de numeração/i)).toBeVisible();
    await page.getByRole('tab', { name: 'Certificado Digital' }).click();
    await expect(page.getByText(/certificado digital A1/i)).toBeVisible();
  });

  test('creates a new filial with a sede address', async ({ page }) => {
    const nome = `${prefix}-novo`;
    await page.goto('/configuracoes/filiais/novo');
    await fillField(page, 'Razão Social', nome);
    await fillField(page, 'CNPJ', '11222333000181');
    await fillField(page, 'Inscrição Estadual', '123456789');
    await fillSede(page);
    await clickSave(page, 'Criar');
    await page.waitForURL(
      (url) =>
        /^\/configuracoes\/filiais\/[^/]+$/.test(url.pathname) &&
        url.pathname !== '/configuracoes/filiais/novo',
      { timeout: 15_000 },
    );
    await expect
      .poll(() => docExistsByField('filiais', 'razaoSocial', nome), {
        timeout: 15_000,
      })
      .toBe(true);

    await page.goto('/configuracoes/filiais');
    await applyTextFilter(page, 'Razão Social', nome);
    await expectRowVisible(page, nome);
  });

  test('rejects creating a filial with an empty Razão Social', async ({ page }) => {
    await page.goto('/configuracoes/filiais/novo');
    await fillField(page, 'CNPJ', '11222333000181');
    await fillSede(page);
    await clickSave(page, 'Criar');
    await expectFieldError(page, 'Razão Social');
    await expect(page).toHaveURL(/\/configuracoes\/filiais\/novo$/);
  });

  test('opens an existing filial from the list', async ({ page }) => {
    await page.goto('/configuracoes/filiais');
    await applyTextFilter(page, 'Razão Social', row(2));
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/configuracoes\/filiais\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Razão Social', { exact: true })).toHaveValue(row(2));
  });

  test('warns about unsaved changes when leaving the edit page', async ({ page }) => {
    await page.goto(`/configuracoes/filiais/${row(4)}`);
    await fillField(page, 'Nome Fantasia', 'edicao-nao-salva');

    let dialogSeen = false;
    page.once('dialog', (d) => {
      dialogSeen = true;
      void d.dismiss();
    });
    await page.getByRole('link', { name: 'Voltar à lista' }).click();
    await expect.poll(() => dialogSeen).toBe(true);
    await expect(page).toHaveURL(/\/configuracoes\/filiais\/[^/]+$/);
  });

  test('edits a filial and saves', async ({ page }) => {
    await page.goto(`/configuracoes/filiais/${row(5)}`);
    await fillField(page, 'Nome Fantasia', 'editado-e2e');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/configuracoes\/filiais$/, { timeout: 15_000 });

    await page.goto(`/configuracoes/filiais/${row(5)}`);
    await expect(page.getByLabel('Nome Fantasia', { exact: true })).toHaveValue('editado-e2e');
  });

  test('shows placeholder tabs for NFe config and digital certificate', async ({ page }) => {
    await page.goto(`/configuracoes/filiais/${row(1)}`);
    await page.getByRole('tab', { name: 'Configurações NFe' }).click();
    await expect(page.getByText(/configuração de numeração/i)).toBeVisible();
    await page.getByRole('tab', { name: 'Certificado Digital' }).click();
    await expect(page.getByText(/certificado digital A1/i)).toBeVisible();
  });

  test('deletes a filial through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/configuracoes/filiais/${row(7)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/configuracoes\/filiais$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Razão Social', row(7));
    await expectEmptyState(page);
  });

  test('keeps column filters in the URL query string', async ({ page }) => {
    await page.goto('/configuracoes/filiais');
    await applyTextFilter(page, 'Razão Social', row(2));
    await expect(page).toHaveURL(/razaoSocial=contains%3A/);

    await page.reload();
    await expectRowVisible(page, row(2));
    await expectRowHidden(page, row(1));

    await clearColumnFilter(page, 'Razão Social');
    await expect(page).not.toHaveURL(/razaoSocial=contains/);
  });
});
