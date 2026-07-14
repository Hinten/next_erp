import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  docExistsByName,
  e2ePrefix,
  getListaDePrecosByName,
  seedCategorias,
  seedListasDePrecos,
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
  selectFieldWithSearch,
} from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/listas-de-precos` TableView + ObjectView flow,
 * driven by `listaDePrecosSchema`. Seeds 7 mock listas (Admin SDK) plus one
 * categoria, then exercises listing, per-column filtering (text + boolean),
 * sorting, create/edit/delete, schema-validation feedback (`nome` required, an
 * empty `formula` blocks the save), the deep-link redirect, the unsaved-changes
 * guard, the composite-field editors (`formulasCalculoPreco` array with staged
 * deletion + `formulasPorCategoria` record) and URL query-param persistence.
 * Runs serially.
 */
test.describe.serial('Listas de preços e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('lp');
  const catPrefix = `${prefix}-cat`;
  const catId = `${catPrefix}-001`;
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async ({ browser }) => {
    // Compiling the cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedListasDePrecos(prefix, 7),
      seedCategorias(catPrefix, 1),
      warmRoutes(browser, [
        '/listas-de-precos',
        '/listas-de-precos/novo',
        '/listas-de-precos/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await Promise.all([
      cleanupByNamePrefix('listaDePrecos', prefix),
      cleanupByNamePrefix('categorias', catPrefix),
    ]);
  });

  test('TableView query works without a filter', async ({ page }) => {
    await page.goto('/listas-de-precos');
    await expect(page.getByRole('heading', { name: 'Listas de preços' })).toBeVisible();
    // The table only mounts once the one-shot Pipelines query resolves — a
    // preview API that can lag well past the 5s default expect timeout.
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('filters rows by the Nome (text) and Ativo (boolean) columns', async ({ page }) => {
    await page.goto('/listas-de-precos');
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
    await page.goto('/listas-de-precos');
    await applyTextFilter(page, 'Nome', `${prefix}-sem-correspondencia`);
    await expectEmptyState(page);
  });

  test('sorts rows by clicking the Nome column header', async ({ page }) => {
    await page.goto('/listas-de-precos');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(1));
    await expect.poll(() => firstRowText(page)).toContain(row(1));

    await clickColumnSort(page, 'Nome'); // asc → desc
    await expect(page).toHaveURL(/sort=nome%3Adesc/);
    await expect.poll(() => firstRowText(page)).toContain(row(7));

    await clickColumnSort(page, 'Nome'); // desc → asc
    await expect.poll(() => firstRowText(page)).toContain(row(1));
  });

  test('navigates to the new-lista page', async ({ page }) => {
    await page.goto('/listas-de-precos');
    await page.getByRole('link', { name: 'Nova lista de preços' }).click();
    await expect(page).toHaveURL(/\/listas-de-precos\/novo$/);
    await expect(page.getByRole('heading', { name: 'Nova lista de preços' })).toBeVisible();
  });

  test('creates a lista with a pricing formula', async ({ page }) => {
    const nome = `${prefix}-novo`;
    await page.goto('/listas-de-precos/novo');
    await fillField(page, 'Nome', nome);

    // Add one formula on its own tab (custom array editor).
    await page.getByRole('tab', { name: 'Fórmulas de cálculo' }).click();
    await page.getByRole('button', { name: 'Adicionar fórmula', exact: true }).click();
    await fillField(page, 'Limiar 1', '100');
    await fillField(page, 'Fórmula 1', 'C*1.5');

    await clickSave(page, 'Criar');
    await page.waitForURL(/\/listas-de-precos\/[^/]+\/editar$/, { timeout: 15_000 });
    await expect.poll(() => docExistsByName('listaDePrecos', nome), { timeout: 15_000 }).toBe(true);

    const data = await getListaDePrecosByName(nome);
    const formulas = data?.formulasCalculoPreco as Array<Record<string, unknown>> | null;
    expect(formulas).toHaveLength(1);
    expect(formulas?.[0]?.formula).toBe('C*1.5');
    expect(formulas?.[0]?.limiar).toBe(100);

    await page.goto('/listas-de-precos');
    await applyTextFilter(page, 'Nome', nome);
    await expectRowVisible(page, nome);
  });

  test('rejects creating a lista without a Nome (required field)', async ({ page }) => {
    await page.goto('/listas-de-precos/novo');
    await clickSave(page, 'Criar');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/listas-de-precos\/novo$/);
  });

  test('rejects creating a lista with an empty formula (schema error on another tab)', async ({
    page,
  }) => {
    await page.goto('/listas-de-precos/novo');
    await fillField(page, 'Nome', `${prefix}-invalida`);
    await page.getByRole('tab', { name: 'Fórmulas de cálculo' }).click();
    // Add a formula but leave the required `formula` expression empty.
    await page.getByRole('button', { name: 'Adicionar fórmula', exact: true }).click();
    await clickSave(page, 'Criar');

    await expect(
      page.getByText(/Corrija os campos inválidos na aba "Fórmulas de cálculo"/),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/listas-de-precos\/novo$/);
  });

  test('opens an existing lista from the list (redirects to the editor)', async ({ page }) => {
    await page.goto('/listas-de-precos');
    await applyTextFilter(page, 'Nome', row(5));
    await page.getByRole('row', { name: new RegExp(row(5)) }).click();
    await page.waitForURL(/\/listas-de-precos\/[^/]+\/editar$/, { timeout: 15_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(5));
  });

  test('a deep link to /listas-de-precos/<id> redirects to the editor', async ({ page }) => {
    await page.goto(`/listas-de-precos/${row(5)}`);
    await page.waitForURL(new RegExp(`/listas-de-precos/${row(5)}/editar$`), { timeout: 15_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(5));
  });

  test('warns about unsaved changes when leaving the edit page', async ({ page }) => {
    await page.goto(`/listas-de-precos/${row(4)}/editar`);
    await fillField(page, 'Nome', `${row(4)}-edicao-nao-salva`);

    let dialogSeen = false;
    page.once('dialog', (d) => {
      dialogSeen = true;
      void d.dismiss();
    });
    await page.getByRole('link', { name: 'Voltar à lista' }).click();
    await expect.poll(() => dialogSeen).toBe(true);
    await expect(page).toHaveURL(/\/listas-de-precos\/[^/]+\/editar$/);
  });

  test('adds a formula on an existing lista and saves', async ({ page }) => {
    await page.goto(`/listas-de-precos/${row(3)}/editar`);
    await page.getByRole('tab', { name: 'Fórmulas de cálculo' }).click();
    await page.getByRole('button', { name: 'Adicionar fórmula', exact: true }).click();
    await fillField(page, 'Limiar 1', '50');
    await fillField(page, 'Fórmula 1', 'C*2');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/listas-de-precos$/, { timeout: 15_000 });

    await expect
      .poll(
        async () => {
          const data = await getListaDePrecosByName(row(3));
          const f = data?.formulasCalculoPreco as unknown[] | null;
          return Array.isArray(f) ? f.length : 0;
        },
        { timeout: 15_000 },
      )
      .toBe(1);
  });

  test('staged deletion: marking a formula defers removal until save', async ({ page }) => {
    await page.goto(`/listas-de-precos/${row(3)}/editar`);
    await page.getByRole('tab', { name: 'Fórmulas de cálculo' }).click();
    await expect(page.getByLabel('Fórmula 1', { exact: true })).toHaveValue('C*2');

    // Mark → "Será excluída" appears; undo → it reverts; re-mark → save drops it.
    await page.getByRole('button', { name: 'Excluir fórmula 1', exact: true }).click();
    await expect(page.getByText('Será excluída')).toBeVisible();
    await page.getByRole('button', { name: 'Desfazer exclusão da fórmula 1', exact: true }).click();
    await expect(page.getByText('Será excluída')).toHaveCount(0);

    await page.getByRole('button', { name: 'Excluir fórmula 1', exact: true }).click();
    await expect(page.getByText('Será excluída')).toBeVisible();
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/listas-de-precos$/, { timeout: 15_000 });

    // Every formula removed → the field collapses to null.
    await expect
      .poll(async () => (await getListaDePrecosByName(row(3)))?.formulasCalculoPreco, {
        timeout: 15_000,
      })
      .toBeNull();
  });

  test('configures a formula bucket per categoria (record editor) and saves', async ({ page }) => {
    await page.goto(`/listas-de-precos/${row(2)}/editar`);
    await page.getByRole('tab', { name: 'Fórmulas por categoria' }).click();
    await selectFieldWithSearch(page, 'Adicionar categoria', catId);
    // The picked categoria becomes a card; name it and save.
    await fillField(page, `Nome da categoria ${catId}`, 'Camisetas');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/listas-de-precos$/, { timeout: 15_000 });

    await expect
      .poll(
        async () => {
          const rec = (await getListaDePrecosByName(row(2)))?.formulasPorCategoria as Record<
            string,
            { name?: string }
          > | null;
          return rec?.[catId]?.name;
        },
        { timeout: 15_000 },
      )
      .toBe('Camisetas');
  });

  test('edits a lista and continues editing', async ({ page }) => {
    await page.goto(`/listas-de-precos/${row(6)}/editar`);
    await fillField(page, 'Nome', `${row(6)}-continua`);
    await clickSaveAndContinue(page);
    await expectToast(page, /Salvo/);
    await expect(page).toHaveURL(/\/listas-de-precos\/[^/]+\/editar$/);
  });

  test('deletes a lista through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/listas-de-precos/${row(7)}/editar`);
    await confirmDelete(page);
    await page.waitForURL(/\/listas-de-precos$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', row(7));
    await expectEmptyState(page);
  });

  test('keeps column filters in the URL query string', async ({ page }) => {
    await page.goto('/listas-de-precos');
    await applyTextFilter(page, 'Nome', row(2));
    await expect(page).toHaveURL(/nome=contains%3A/);

    await page.reload();
    await expectRowVisible(page, row(2));
    await expectRowHidden(page, row(1));

    await clearColumnFilter(page, 'Nome');
    await expect(page).not.toHaveURL(/nome=contains/);
  });
});
