import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  docExistsByName,
  e2ePrefix,
  getTabMediByName,
  seedMedidaComMarketplace,
  seedMedidas,
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
  clickSaveAndContinue,
  confirmDelete,
  expectFieldAfterReload,
  expectFieldError,
  expectToast,
  fillField,
} from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/medidas` (tabela de medidas / moda) TableView
 * + ObjectView flow, driven by `tabelaDeMedidasSchema`. Seeds 7 mock tabelas
 * plus one carrying marketplace maps and a photo reference, then
 * exercises listing, Nome filtering, sorting, create/edit/delete, the
 * `nome`-required validation, the unsaved-changes guard and URL persistence.
 *
 * The headline regression — `preserves the marketplace maps when editing` —
 * asserts that editing another field of a tabela leaves both size-chart maps
 * byte-for-byte intact (ObjectView writes a dirty-field patch, so a field the
 * edit never dirtied is never clobbered). The Mercado Livre map never enters
 * the form; the Shopee map does (its tab stages picks and the save writes them —
 * `medidas-shopee.cadastros.e2e.spec.ts`), so this also pins that the tab —
 * mounted even unopened (Mantine `keepMounted`) — never dirties it on its own.
 * Runs serially.
 */
test.describe.serial('Medidas e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('med');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;
  let mkt: Awaited<ReturnType<typeof seedMedidaComMarketplace>>;

  test.beforeAll(async ({ browser }) => {
    // Compiling cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    const [, seeded] = await Promise.all([
      seedMedidas(prefix, 7),
      seedMedidaComMarketplace(prefix),
      // Pre-compile the routes this suite drives (the dynamic `/medidas/[id]`
      // is warmed via the `__aquecimento__` id).
      warmRoutes(browser, ['/medidas', '/medidas/novo', '/medidas/__aquecimento__']),
    ]);
    mkt = seeded;
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('tabMedi', prefix);
  });

  test('TableView query works without a filter', async ({ page }) => {
    await page.goto('/medidas');
    await expect(page.getByRole('heading', { name: 'Tabelas de medidas' })).toBeVisible();
    // The table only mounts once the (one-shot) query resolves — can lag past
    // the 5s default expect timeout on a cold backend.
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('filters rows by the Nome column', async ({ page }) => {
    await page.goto('/medidas');
    await applyTextFilter(page, 'Nome', row(3));
    await expectRowVisible(page, row(3));
    await expectRowHidden(page, row(1));
    await clearColumnFilter(page, 'Nome');
  });

  test('shows the empty state when a filter matches nothing', async ({ page }) => {
    await page.goto('/medidas');
    await applyTextFilter(page, 'Nome', `${prefix}-sem-correspondencia`);
    await expectEmptyState(page);
  });

  test('sorts rows by clicking the Nome column header', async ({ page }) => {
    await page.goto('/medidas');
    // Filter to the numbered rows only (excludes the `-mkt` fixture).
    await applyTextFilter(page, 'Nome', `${prefix}-0`);

    // The default sort is `ultimaModificacao DESC` (seeds carry null), so the
    // pre-click order isn't name-based — drive the Nome sort explicitly. A first
    // click on an unsorted column is ascending, the second descending.
    await clickColumnSort(page, 'Nome'); // unsorted → asc
    await expect(page).toHaveURL(/sort=nome%3Aasc/);
    await expect.poll(() => firstRowText(page), { timeout: 15_000 }).toContain(row(1));

    await clickColumnSort(page, 'Nome'); // asc → desc
    await expect(page).toHaveURL(/sort=nome%3Adesc/);
    await expect.poll(() => firstRowText(page), { timeout: 15_000 }).toContain(row(7));
  });

  test('navigates to the new-tabela page', async ({ page }) => {
    await page.goto('/medidas');
    await page.getByRole('link', { name: 'Nova tabela de medidas' }).click();
    await expect(page).toHaveURL(/\/medidas\/novo$/);
    await expect(page.getByRole('heading', { name: 'Nova tabela de medidas' })).toBeVisible();
  });

  test('creates a new tabela de medidas', async ({ page }) => {
    const nome = `${prefix}-novo`;
    await page.goto('/medidas/novo');
    await fillField(page, 'Nome', nome);
    await fillField(page, 'Código interno', 'COD-NOVO');
    await clickSave(page, 'Criar');
    // onSaved does router.replace('/medidas/<id>'). Match the detail route
    // explicitly: a plain /medidas/[^/]+$ also matches the /medidas/novo we're
    // already on, so it would resolve before the create even commits.
    await page.waitForURL(
      (url) => /^\/medidas\/[^/]+$/.test(url.pathname) && url.pathname !== '/medidas/novo',
      { timeout: 15_000 },
    );
    // Confirm the doc actually committed (Admin SDK reads are strongly
    // consistent) before loading the list, so the list query can't race ahead.
    await expect.poll(() => docExistsByName('tabMedi', nome), { timeout: 15_000 }).toBe(true);

    await page.goto('/medidas');
    await applyTextFilter(page, 'Nome', nome);
    await expectRowVisible(page, nome);
  });

  test('rejects creating a tabela without a Nome (required field)', async ({ page }) => {
    await page.goto('/medidas/novo');
    // Leave "Nome" empty — tabelaDeMedidasSchema requires nome.min(1).
    await clickSave(page, 'Criar');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/medidas\/novo$/);
  });

  test('opens an existing tabela from the list', async ({ page }) => {
    await page.goto('/medidas');
    await applyTextFilter(page, 'Nome', row(2));
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/medidas\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('warns about unsaved changes when leaving the edit page', async ({ page }) => {
    await page.goto(`/medidas/${row(4)}`);
    await fillField(page, 'Código interno', 'edicao-nao-salva');

    let dialogSeen = false;
    page.once('dialog', (d) => {
      dialogSeen = true;
      void d.dismiss();
    });
    await page.getByRole('link', { name: 'Voltar à lista' }).click();
    await expect.poll(() => dialogSeen).toBe(true);
    await expect(page).toHaveURL(/\/medidas\/[^/]+$/);
  });

  test('edits a tabela and saves', async ({ page }) => {
    await page.goto(`/medidas/${row(5)}`);
    await fillField(page, 'Código interno', 'editado-e2e');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/medidas$/, { timeout: 15_000 });

    await page.goto(`/medidas/${row(5)}`);
    await expectFieldAfterReload(page, 'Código interno', 'editado-e2e');
  });

  test('edits a tabela and continues editing', async ({ page }) => {
    await page.goto(`/medidas/${row(6)}`);
    await fillField(page, 'Código interno', 'continua-editando');
    await clickSaveAndContinue(page);
    await expectToast(page, /Salvo/);
    await expect(page).toHaveURL(/\/medidas\/[^/]+$/);
  });

  test('rejects editing a tabela with an empty Nome', async ({ page }) => {
    await page.goto(`/medidas/${row(1)}`);
    await fillField(page, 'Nome', '');
    await clickSave(page, 'Salvar alterações');
    await expectFieldError(page, 'Nome');
    await expect(page).toHaveURL(/\/medidas\/[^/]+$/);
  });

  test('deletes a tabela through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/medidas/${row(7)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/medidas$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', row(7));
    await expectEmptyState(page);
  });

  test('keeps column filters in the URL query string', async ({ page }) => {
    await page.goto('/medidas');
    await applyTextFilter(page, 'Nome', row(2));
    await expect(page).toHaveURL(/nome=contains%3A/);

    await page.reload();
    await expectRowVisible(page, row(2));
    await expectRowHidden(page, row(1));

    await clearColumnFilter(page, 'Nome');
    await expect(page).not.toHaveURL(/nome=contains/);
  });

  test('preserves the marketplace maps when editing through the form', async ({ page }) => {
    // Both size-chart maps must survive a plain edit. The ML map is excluded
    // from the form; the Shopee map is a form field (the Shopee tab stages
    // picks), but its tab never writes the value on mount, so editing only
    // Descrição produces a dirty-field patch that touches neither map.
    await page.goto(`/medidas/${mkt.id}`);
    await fillField(page, 'Descrição', 'editado-mkt');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/medidas$/, { timeout: 15_000 });

    const data = await getTabMediByName(mkt.nome);
    expect(data?.descricao).toBe('editado-mkt');
    expect(data?.tabelasDeMedidasMercadoLivre).toEqual(mkt.mercadoLivre);
    expect(data?.tabelasMedidasShopee).toEqual(mkt.shopee);
  });
  test('copies ordinary fields without sharing marketplace bindings or photo ownership', async ({
    page,
  }) => {
    const copiedName = `${prefix}-copia-mkt`;
    const source = await getTabMediByName(mkt.nome);
    expect(source).not.toBeNull();
    expect(source?.fotos).toHaveLength(1);
    expect(source?.fotosArquivosIds).toHaveLength(1);

    await page.goto('/medidas');
    await applyTextFilter(page, 'Nome', mkt.nome);
    const sourceRow = page.getByRole('row', { name: new RegExp(mkt.nome) });
    await expect(sourceRow).toBeVisible();
    await sourceRow.getByRole('checkbox').check();
    await page.getByRole('link', { name: 'Copiar', exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('copyFrom') === mkt.id);
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(mkt.nome);
    await fillField(page, 'Nome', copiedName);
    await clickSave(page, 'Criar');
    await page.waitForURL(
      (url) => /^\/medidas\/[^/]+$/.test(url.pathname) && url.pathname !== '/medidas/novo',
      { timeout: 15_000 },
    );
    expect(page.url().split('/').pop()).not.toBe(mkt.id);

    await expect.poll(() => docExistsByName('tabMedi', copiedName)).toBe(true);
    const copied = await getTabMediByName(copiedName);
    expect(copied?.codigo).toBe(source?.codigo);
    expect(copied?.descricao).toBe(source?.descricao);
    expect(copied?.fotos).toBeNull();
    expect(copied?.fotosArquivosIds).toBeNull();
    expect(copied?.tabelasDeMedidasMercadoLivre).toBeNull();
    expect(copied?.tabelasMedidasShopee).toBeNull();

    const unchanged = await getTabMediByName(mkt.nome);
    expect(unchanged?.fotos).toEqual(source?.fotos);
    expect(unchanged?.fotosArquivosIds).toEqual(source?.fotosArquivosIds);
    expect(unchanged?.tabelasDeMedidasMercadoLivre).toEqual(mkt.mercadoLivre);
    expect(unchanged?.tabelasMedidasShopee).toEqual(mkt.shopee);
  });
});
