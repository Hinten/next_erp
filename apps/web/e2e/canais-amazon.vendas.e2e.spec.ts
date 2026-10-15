import { expect, test } from '@playwright/test';
import {
  cleanupAmazonFixtures,
  docExistsByName,
  e2ePrefix,
  getIntegracaoById,
  seedAmazonFixtures,
  seedShopeeFixtures,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowHidden, expectRowVisible } from './helpers/table-view';
import {
  clickSave,
  confirmDelete,
  expectFieldAfterReload,
  expectFieldError,
  expectToast,
  fillField,
  selectFieldWithSearch,
} from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/canais/amazon` TableView + ObjectView flow,
 * driven by `integracaoSchema` filtered to `tipo == 8` (Amazon). Mirrors the
 * Loja Integrada suite; row lookup leans on the run-scoped `nome` prefix.
 *
 * The `apps/amazon` backend does NOT run in this suite, and these screens never
 * talk to it: they register the conta in Firestore and nothing else. The
 * seller id is seeded through the Admin SDK, as the OAuth callback writes it,
 * and the form is asserted to show it read-only.
 */
test.describe.serial('Canais Amazon e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('amz');
  // A second prefix for the near-miss conta of ANOTHER channel. The seed writes
  // `<prefix>-NNN` whatever the tipo, so reusing `prefix` would overwrite an
  // Amazon row instead of adding a Shopee one. `cleanupAmazonFixtures(prefix)`
  // still sweeps it: the cleanup is by name prefix, not by tipo.
  const outroPrefix = `${prefix}-outro`;
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;
  const refLabel = `${prefix}-ref`;
  // Filled by `beforeAll`: the conta the seed bound to a seller (row 1), and
  // the placeholder seller id it carries.
  let contaComVendedorId = '';
  let sellingPartnerId = '';

  test.beforeAll(async ({ browser }) => {
    // Compiling 3 cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    const [amazon] = await Promise.all([
      seedAmazonFixtures(prefix, 5),
      seedShopeeFixtures(outroPrefix, 1),
      warmRoutes(browser, [
        '/canais/amazon',
        '/canais/amazon/novo',
        '/canais/amazon/__aquecimento__',
      ]),
    ]);
    contaComVendedorId = amazon.contaComVendedorId;
    sellingPartnerId = amazon.sellingPartnerId;
  });

  test.afterAll(async () => {
    await cleanupAmazonFixtures(prefix);
  });

  test('TableView lists Amazon contas only', async ({ page }) => {
    await page.goto('/canais/amazon');
    await expect(page.getByRole('heading', { name: 'Amazon' })).toBeVisible();
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
    await page.goto('/canais/amazon');
    await expect(page.getByText('O que esta tela faz hoje')).toBeVisible();
    await expect(page.getByText('nada é sincronizado', { exact: false })).toBeVisible();
  });

  test('navigates to the new-conta page', async ({ page }) => {
    await page.goto('/canais/amazon');
    await page.getByRole('link', { name: 'Nova conta' }).click();
    await expect(page).toHaveURL(/\/canais\/amazon\/novo$/);
    await expect(page.getByRole('heading', { name: 'Nova conta Amazon' })).toBeVisible();
  });

  test('creates a new conta and lands on its edit page', async ({ page }) => {
    const nome = `${prefix}-nova`;
    await page.goto('/canais/amazon/novo');
    await fillField(page, 'Nome', nome);
    // The dropdowns cap at 15 docs: type to trigger the server-side search so
    // the run-scoped fixture refs are found regardless of their position.
    await selectFieldWithSearch(page, 'Filial', `${refLabel}-filial`);
    await selectFieldWithSearch(page, 'Tabela de preços', `${refLabel}-lista`);
    await selectFieldWithSearch(page, 'Depósito', `${refLabel}-deposito`);
    await clickSave(page, 'Criar');

    // onSaved does router.replace('/canais/amazon/<id>').
    await page.waitForURL(
      (url) =>
        /^\/canais\/amazon\/[^/]+$/.test(url.pathname) && url.pathname !== '/canais/amazon/novo',
      { timeout: 15_000 },
    );
    await expect.poll(() => docExistsByName('integracao', nome), { timeout: 15_000 }).toBe(true);
    await expect(page.getByRole('heading', { name: 'Conta Amazon' })).toBeVisible();
    // A fresh conta is bound to no seller: the read-only field is empty.
    await expect(page.getByLabel('Selling Partner ID', { exact: true })).toHaveValue('');

    await page.goto('/canais/amazon');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, nome);
  });

  test('opens an existing conta from the list', async ({ page }) => {
    await page.goto('/canais/amazon');
    await applyTextFilter(page, 'Nome', prefix);
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/canais\/amazon\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('shows selling_partner_id read-only, with the seller the conta is bound to', async ({
    page,
  }) => {
    await page.goto(`/canais/amazon/${contaComVendedorId}`);
    const spid = page.getByLabel('Selling Partner ID', { exact: true });
    await expect(spid).toHaveValue(sellingPartnerId);
    await expect(spid).toBeDisabled();
  });

  /**
   * A CNPJ one digit short. `integracaoSchema.cpf_cnpj`'s regex alone would
   * take it (its `\d*` branch accepts any run of digits); the form's
   * `validarIntermediador` is what refuses it, so it never reaches
   * `<infIntermed>` to fail there at emission.
   *
   * The field error alone proves nothing about the save: ObjectView validates
   * on blur, so it is already showing before Save is pressed. The toast is
   * what only a REFUSED submit raises (`onInvalid` instead of the save), and
   * the Admin read then confirms nothing reached the doc — row 1 is seeded
   * with `cpf_cnpj: null`, and the edit test below runs after this one.
   */
  test('refuses a 13-digit intermediador CNPJ', async ({ page }) => {
    await page.goto(`/canais/amazon/${contaComVendedorId}`);
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(1));
    await fillField(page, 'CNPJ do intermediador', '1234567890123');
    await clickSave(page, 'Salvar alterações');
    await expectFieldError(page, 'CNPJ do intermediador');
    await expectToast(page, 'Corrija os campos inválidos antes de salvar.');
    expect((await getIntegracaoById(contaComVendedorId))?.cpf_cnpj).toBeNull();
  });

  test('edits nome and the intermediador fields, keeping the seller id', async ({ page }) => {
    const nome = `${prefix}-001-editada`;
    const cnpjAlfa = '12ABC34501DE35';
    // A fixed placeholder, not the run prefix: the input caps at 60 characters,
    // and a long run id must not truncate the value this test reads back.
    const idIntermediador = 'e2e-id-intermediador';
    await page.goto(`/canais/amazon/${contaComVendedorId}`);
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(1));
    await fillField(page, 'Nome', nome);
    await fillField(page, 'CNPJ do intermediador', cnpjAlfa);
    // The letters survive typing: the input stores the cleaned 14 characters.
    await expect(page.getByLabel('CNPJ do intermediador', { exact: true })).toHaveValue(cnpjAlfa);
    // Typed with a space on each edge, as a paste from a seller portal brings
    // it: the save trims them (the NF-e XSD's TString refuses edge whitespace).
    await fillField(page, 'Identificador no intermediador', ` ${idIntermediador} `);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/canais\/amazon$/, { timeout: 15_000 });

    await page.goto(`/canais/amazon/${contaComVendedorId}`);
    await expectFieldAfterReload(page, 'Nome', nome);
    await expect(page.getByLabel('CNPJ do intermediador', { exact: true })).toHaveValue(cnpjAlfa);
    await expect(page.getByLabel('Identificador no intermediador', { exact: true })).toHaveValue(
      idIntermediador,
    );
    // The read-only seller id survives an edit of the conta it is bound to.
    await expect(page.getByLabel('Selling Partner ID', { exact: true })).toHaveValue(
      sellingPartnerId,
    );
  });

  test('deletes a conta through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/canais/amazon/${row(5)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/canais\/amazon$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowHidden(page, row(5));
  });
});
