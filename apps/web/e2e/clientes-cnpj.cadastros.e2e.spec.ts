import { expect, test, type Page } from '@playwright/test';
import { cleanupByNamePrefix, e2ePrefix } from './_helpers/seed-data';
import { clickSave, fillField, selectField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the CNPJ "buscar dados" lookup on the cliente form
 * (`CnpjLookupField`). The external calls are stubbed at the network layer
 * (BrasilAPI for razão social + endereço; the apps/nfe Consulta Cadastro route,
 * forced to `supported:false` so the IE is deterministic) — staging can't hit
 * real SEFAZ / public APIs reliably. Asserts: the button shows for any tipo and
 * is always clickable (validating on click — an invalid CNPJ shows an error and
 * skips the API), a CNPJ lookup auto-switches the tipo to PJ and fills Nome +
 * offers the address, and saving the relayed address writes an endereço.
 */
const CNPJ = '11222333000181'; // checksum-valid
const RAZAO = 'EMPRESA EXEMPLO LTDA';
const LOGRADOURO = 'AVENIDA PAULISTA';

async function stubCnpjLookup(page: Page): Promise<void> {
  await page.route('https://brasilapi.com.br/api/cnpj/v1/**', (route) =>
    route.fulfill({
      json: {
        razao_social: RAZAO,
        nome_fantasia: 'Exemplo',
        descricao_tipo_de_logradouro: 'AVENIDA',
        logradouro: 'PAULISTA',
        numero: '1000',
        complemento: 'SALA 1',
        bairro: 'BELA VISTA',
        cep: '01310100',
        municipio: 'SAO PAULO',
        uf: 'SP',
        codigo_municipio_ibge: 3550308,
      },
    }),
  );
  // SEFAZ Consulta Cadastro is best-effort; force a deterministic "no IE".
  await page.route('**/api/nfe/consulta-cadastro*', (route) =>
    route.fulfill({
      json: { supported: false, uf: 'SP', cStat: null, xMotivo: 'stub', infCad: [] },
    }),
  );
}

/**
 * Click "buscar dados" and retry until Nome fills. A click that lands before the
 * lookup wiring settles can silently no-op (e.g. the async default-filial query
 * the SEFAZ leg depends on); the lookup is idempotent, so retrying is safe. Same
 * robustness pattern as the pedidos quick-create spec.
 */
async function lookupUntilNome(page: Page, razao: string): Promise<void> {
  const buscar = page.getByRole('button', { name: 'Buscar dados do CNPJ' });
  await expect(async () => {
    await buscar.click();
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(razao, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

test.describe.serial('Clientes e2e — CNPJ lookup', () => {
  const prefix = e2ePrefix('cli-cnpj');

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await warmRoutes(browser, ['/clientes/novo']);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('clientes', prefix);
  });

  test('shows the "buscar dados" button for any tipo and validates on click', async ({ page }) => {
    const button = page.getByRole('button', { name: 'Buscar dados do CNPJ' });
    // A valid CNPJ would call BrasilAPI; track that an INVALID click never does.
    let apiCalled = false;
    await page.route('https://brasilapi.com.br/api/cnpj/v1/**', (route) => {
      apiCalled = true;
      return route.fulfill({ json: {} });
    });

    await page.goto('/clientes/novo');
    // #293: the button is present AND clickable regardless of tipo (no disabled
    // state) — it validates on click instead.
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();

    await selectField(page, 'Tipo', 'Pessoa Física');
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();

    // Clicking with no/invalid CNPJ surfaces the validation message and never
    // hits the API.
    await button.click();
    await expect(
      page.getByText('Informe um CNPJ válido (14 dígitos) para buscar os dados.'),
    ).toBeVisible();
    expect(apiCalled).toBe(false);
  });

  test('auto-switches Pessoa Física to PJ when a CNPJ is looked up', async ({ page }) => {
    await stubCnpjLookup(page);
    await page.goto('/clientes/novo');
    await selectField(page, 'Tipo', 'Pessoa Física');
    await fillField(page, 'CPF / CNPJ', CNPJ);

    // A CNPJ ⇒ PJ: the lookup flips the tipo (so PF + CNPJ never stays invalid)
    // and fills nome. The stub forces supported:false, so IE is left blank.
    await lookupUntilNome(page, RAZAO);
    await expect(page.getByRole('combobox', { name: 'Tipo', exact: true })).toHaveValue(
      'Pessoa Jurídica',
    );
  });

  test('fills razão social and offers the address on lookup', async ({ page }) => {
    await stubCnpjLookup(page);
    await page.goto('/clientes/novo');
    await selectField(page, 'Tipo', 'Pessoa Jurídica');
    await fillField(page, 'CPF / CNPJ', CNPJ);
    await lookupUntilNome(page, RAZAO);

    await expect(page.getByText('Endereço encontrado')).toBeVisible();
  });

  test('registers the resolved address under the new cliente', async ({ page }) => {
    await stubCnpjLookup(page);
    await page.goto('/clientes/novo');
    await selectField(page, 'Tipo', 'Pessoa Jurídica');
    await fillField(page, 'CPF / CNPJ', CNPJ);
    await lookupUntilNome(page, RAZAO);

    // Rename to a run-scoped prefix so afterAll cleanup catches the doc.
    const nome = `${prefix}-pj`;
    await fillField(page, 'Nome', nome);
    await clickSave(page, 'Criar');

    // Redirects to the detail page, which pops the relayed address and opens the
    // prefilled "Novo endereço" modal.
    await page.waitForURL(
      (url) => /^\/clientes\/[^/]+$/.test(url.pathname) && url.pathname !== '/clientes/novo',
      { timeout: 15_000 },
    );
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Novo endereço' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(dialog.getByLabel('Logradouro', { exact: true })).toHaveValue(LOGRADOURO);

    // Save the endereço; it should land in the cliente's Endereços table.
    await dialog.getByRole('button', { name: 'Criar' }).click();
    await expect(page.getByRole('cell', { name: LOGRADOURO })).toBeVisible({ timeout: 15_000 });
  });
});
