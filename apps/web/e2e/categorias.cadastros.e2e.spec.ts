import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  docExistsByName,
  e2ePrefix,
  seedCategorias,
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
 * End-to-end coverage for the `/categorias` TableView + ObjectView flow,
 * driven by the `categoriaSchema`. Seeds 7 mock categorias (Admin SDK),
 * then exercises listing, per-column filtering (text + boolean), sorting,
 * create/edit/delete, schema-validation feedback (`nome` is required), the
 * unsaved-changes guard and URL query-param persistence. Runs serially.
 */
test.describe.serial('Categorias e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('cat');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async ({ browser }) => {
    // Compiling 3 cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedCategorias(prefix, 7),
      // Pre-compile the routes this suite drives so the Next dev cold-compile
      // cost isn't charged to the first assertion (was flaking on 5s expects).
      warmRoutes(browser, ['/categorias', '/categorias/novo', '/categorias/__aquecimento__']),
    ]);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('categorias', prefix);
  });

  test('TableView query works without a filter', async ({ page }) => {
    await page.goto('/categorias');
    await expect(page.getByRole('heading', { name: 'Categorias' })).toBeVisible();
    // The table only mounts once the (one-shot) Pipelines query resolves —
    // a preview API that can lag well past the 5s default expect timeout.
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('filters rows by the Nome (text) and Permite cadastro (boolean) columns', async ({
    page,
  }) => {
    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', row(3));
    await expectRowVisible(page, row(3));
    await expectRowHidden(page, row(1));
    await clearColumnFilter(page, 'Nome');

    // Seeded permiteCadastro = (i % 2 === 0) → true at i=2,4,6.
    await applyTextFilter(page, 'Nome', prefix);
    await applySelectFilter(page, 'Permite cadastro', 'Sim');
    await expectRowVisible(page, row(2));
    await expectRowHidden(page, row(1));
  });

  test('shows the empty state when a filter matches nothing', async ({ page }) => {
    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', `${prefix}-sem-correspondencia`);
    await expectEmptyState(page);
  });

  test('sorts rows by clicking the Nome column header', async ({ page }) => {
    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(1));
    await expect.poll(() => firstRowText(page)).toContain(row(1));

    await clickColumnSort(page, 'Nome'); // asc → desc
    await expect(page).toHaveURL(/sort=nome%3Adesc/);
    await expect.poll(() => firstRowText(page)).toContain(row(7));

    await clickColumnSort(page, 'Nome'); // desc → asc
    await expect.poll(() => firstRowText(page)).toContain(row(1));
  });

  test('navigates to the new-categoria page', async ({ page }) => {
    await page.goto('/categorias');
    await page.getByRole('link', { name: 'Nova categoria' }).click();
    await expect(page).toHaveURL(/\/categorias\/novo$/);
    await expect(page.getByRole('heading', { name: 'Nova categoria' })).toBeVisible();
  });

  test('creates a new categoria with derived nomeCompleto', async ({ page }) => {
    const nome = `${prefix}-novo`;
    await page.goto('/categorias/novo');
    await fillField(page, 'Nome', nome);
    await clickSave(page, 'Criar');
    // onSaved does router.replace('/categorias/<id>'). Match the detail route
    // explicitly: a plain /categorias/[^/]+$ also matches the /categorias/novo
    // we're already on, so it would resolve before the create even commits.
    await page.waitForURL(
      (url) => /^\/categorias\/[^/]+$/.test(url.pathname) && url.pathname !== '/categorias/novo',
      { timeout: 15_000 },
    );
    // Confirm the doc is actually committed (Admin SDK reads are strongly
    // consistent) before loading the list, so the list query can't race the
    // write. A failure here localises the bug to the create itself.
    await expect.poll(() => docExistsByName('categorias', nome), { timeout: 15_000 }).toBe(true);

    // Root category: breadcrumb equals nome; field is read-only (#554).
    await expect(page.getByLabel('Nome completo', { exact: true })).toHaveValue(nome);
    await expect(page.getByLabel('Nome completo', { exact: true })).toBeDisabled();

    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', nome);
    await expectRowVisible(page, nome);
  });

  test('parent picker derives breadcrumb and rename cascades to child', async ({ page }) => {
    const parentNome = `${prefix}-pai-cascade`;
    const childNome = `${prefix}-filho-cascade`;

    // Create parent (root).
    await page.goto('/categorias/novo');
    await fillField(page, 'Nome', parentNome);
    await clickSave(page, 'Criar');
    await page.waitForURL(
      (url) => /^\/categorias\/[^/]+$/.test(url.pathname) && url.pathname !== '/categorias/novo',
      { timeout: 15_000 },
    );
    await expect
      .poll(() => docExistsByName('categorias', parentNome), { timeout: 15_000 })
      .toBe(true);

    // Create child under parent.
    await page.goto('/categorias/novo');
    await fillField(page, 'Nome', childNome);
    await selectFieldWithSearch(page, 'Categoria pai', parentNome);
    await clickSave(page, 'Criar');
    await page.waitForURL(
      (url) => /^\/categorias\/[^/]+$/.test(url.pathname) && url.pathname !== '/categorias/novo',
      { timeout: 15_000 },
    );
    await expect(page.getByLabel('Nome completo', { exact: true })).toHaveValue(
      `${parentNome} > ${childNome}`,
    );

    // Rename parent → child breadcrumb must update (cascade).
    const parentRenamed = `${parentNome}-ren`;
    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', parentNome);
    await page.getByRole('row', { name: new RegExp(parentNome) }).click();
    await page.waitForURL(/\/categorias\/[^/]+$/, { timeout: 10_000 });
    await fillField(page, 'Nome', parentRenamed);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/categorias$/, { timeout: 15_000 });

    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', childNome);
    await page.getByRole('row', { name: new RegExp(childNome) }).click();
    await page.waitForURL(/\/categorias\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome completo', { exact: true })).toHaveValue(
      `${parentRenamed} > ${childNome}`,
    );
  });

  test('rejects creating a categoria without a Nome (required field)', async ({ page }) => {
    await page.goto('/categorias/novo');
    // Leave "Nome" empty — categoriaSchema requires nome.min(1).
    await clickSave(page, 'Criar');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/categorias\/novo$/);
  });

  test('opens an existing categoria from the list', async ({ page }) => {
    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', row(2));
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/categorias\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('warns about unsaved changes when leaving the edit page', async ({ page }) => {
    await page.goto(`/categorias/${row(4)}`);
    // nomeCompleto is derived/read-only (#554) — dirty the editable Nome instead.
    await fillField(page, 'Nome', `${row(4)}-dirty`);

    let dialogSeen = false;
    page.once('dialog', (d) => {
      dialogSeen = true;
      void d.dismiss();
    });
    await page.getByRole('link', { name: 'Voltar à lista' }).click();
    await expect.poll(() => dialogSeen).toBe(true);
    await expect(page).toHaveURL(/\/categorias\/[^/]+$/);
  });

  test('edits a categoria and saves — nomeCompleto is derived from nome', async ({ page }) => {
    const novoNome = `${prefix}-editado`;
    await page.goto(`/categorias/${row(5)}`);
    await fillField(page, 'Nome', novoNome);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/categorias$/, { timeout: 15_000 });

    await page.goto(`/categorias/${row(5)}`);
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(novoNome);
    // Root category (seed has no parent) → breadcrumb equals nome.
    await expect(page.getByLabel('Nome completo', { exact: true })).toHaveValue(novoNome);
    await expect(page.getByLabel('Nome completo', { exact: true })).toBeDisabled();
  });

  test('edits a categoria and continues editing', async ({ page }) => {
    await page.goto(`/categorias/${row(6)}`);
    await fillField(page, 'Nome', `${row(6)}-continua`);
    await clickSaveAndContinue(page);
    await expectToast(page, /Salvo/);
    await expect(page).toHaveURL(/\/categorias\/[^/]+$/);
  });

  test('rejects editing a categoria with an empty Nome', async ({ page }) => {
    await page.goto(`/categorias/${row(1)}`);
    await fillField(page, 'Nome', '');
    await clickSave(page, 'Salvar alterações');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/categorias\/[^/]+$/);
  });

  test('deletes a categoria through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/categorias/${row(7)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/categorias$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', row(7));
    await expectEmptyState(page);
  });

  test('keeps column filters in the URL query string', async ({ page }) => {
    await page.goto('/categorias');
    await applyTextFilter(page, 'Nome', row(2));
    await expect(page).toHaveURL(/nome=contains%3A/);

    await page.reload();
    await expectRowVisible(page, row(2));
    await expectRowHidden(page, row(1));

    await clearColumnFilter(page, 'Nome');
    await expect(page).not.toHaveURL(/nome=contains/);
  });

  test('keeps the sort in the URL and persists hidden columns', async ({ page }) => {
    await page.goto('/categorias');
    await clickColumnSort(page, 'Nome completo');
    await expect(page).toHaveURL(/sort=nomeCompleto%3A/);

    await page.getByRole('button', { name: 'Configurar colunas' }).click();
    await page.getByRole('checkbox', { name: 'Nome completo' }).uncheck();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByRole('columnheader', { name: /Nome completo/ })).toHaveCount(0);
  });
});
