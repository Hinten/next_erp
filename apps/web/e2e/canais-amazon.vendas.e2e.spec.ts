import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
  CODIGO_ERRO_AMAZON,
  type RespostaInicioOAuthAmazon,
  type StatusContaAmazon,
} from '@delfrance/schemas';
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
 * The `apps/amazon` backend does NOT run in this suite. The CRUD cases register
 * the conta in Firestore and assert nothing about the connection panel above
 * the form: its read goes wherever the build points, beside the form. The
 * seller id is seeded through the Admin SDK, as the OAuth callback writes it,
 * and the form is asserted to show it read-only.
 *
 * The connection panel's cases (at the end) STUB the backend with `page.route`
 * — the real routes, the state store and the callback are covered by the
 * backend's offline tests.
 *
 * ⚠️ No case may ever reach Amazon (master plan D11). The stubbed start answers
 * a consent URL on a LOCAL dummy path that the stubs serve themselves, so the
 * "navigation to the consent page" lands on this app's own origin; and, as a
 * belt installed for EVERY case of the suite (the CRUD ones render the live
 * panel too), every request to Seller Central is aborted and every request to
 * an Amazon host is recorded and asserted absent after the case. The
 * `beforeAll` warm-up runs in its own browser context, outside the belt; it only
 * loads pages and clicks nothing.
 */

/** Every conta route hangs off this path, whatever host `NEXT_PUBLIC_AMAZON_URL` points the build at. */
const CONTA_PATH = '/api/marketplace/amazon/conta/';

/** The dummy consent page the stubbed start points at — on the app's own origin, served by the stub. */
const CONSENTIMENTO_LOCAL = '/__e2e__/consentimento-amazon';

/** A connected conta, authorized long before the reauthorization threshold. */
const STATUS_CONECTADA: StatusContaAmazon = {
  connected: true,
  credencialInvalida: false,
  autorizadoEm: '2026-03-10',
  reautorizarAte: '2027-03-10',
  diasParaReautorizar: 146,
  reconexaoPendente: null,
  chamadasLigadas: true,
};

/** A conta never connected, on a backend whose read switch is off (every environment until the cutover). */
const STATUS_DESLIGADA: StatusContaAmazon = {
  connected: false,
  credencialInvalida: false,
  autorizadoEm: null,
  reautorizarAte: null,
  diasParaReautorizar: null,
  reconexaoPendente: null,
  chamadasLigadas: false,
};

/** One request the stubs saw. */
interface ChamadaAmazon {
  readonly method: string;
  readonly pathname: string;
  readonly authorization: string | undefined;
  readonly temCorpo: boolean;
}

interface StubsAmazon {
  /** Every status GET, in order. */
  readonly status: ChamadaAmazon[];
  /** Every oauth/start POST, in order. */
  readonly start: ChamadaAmazon[];
  /** Anything else that reached a conta route — each answered 409. */
  readonly inesperadas: ChamadaAmazon[];
  /** Every navigation that reached the local dummy consent page. */
  readonly consentimento: string[];
}

interface OpcoesStubsAmazon {
  /** What the status GET answers. */
  readonly status: StatusContaAmazon;
  /**
   * What the FIRST oauth/start answers: `'consentimento-local'` answers 200
   * with the local dummy consent URL; otherwise a status and body. A second
   * start is unexpected.
   */
  readonly start?: 'consentimento-local' | { readonly status: number; readonly corpo: unknown };
}

async function chamadaDe(route: Route): Promise<ChamadaAmazon> {
  const req = route.request();
  return {
    method: req.method(),
    pathname: new URL(req.url()).pathname,
    authorization: (await req.allHeaders())['authorization'],
    temCorpo: req.postData() !== null,
  };
}

/** Is this URL on an Amazon host (`amazon.com`, `amazon.com.br`, any subdomain)? */
function ehHostAmazon(url: string): boolean {
  return /(^|\.)amazon\.com(\.br)?$/i.test(new URL(url).hostname);
}

/**
 * The D11 belt, for one page: abort every request to Seller Central, and record
 * every request to an Amazon host. The caller asserts the record EMPTY — an
 * aborted request still fires `request`, so a regressed consent URL fails the
 * case instead of passing quietly. MUST run BEFORE `page.goto`.
 */
async function instalarCintoAmazon(page: Page): Promise<string[]> {
  const amazon: string[] = [];
  page.on('request', (req) => {
    if (ehHostAmazon(req.url())) amazon.push(req.url());
  });
  await page.route('https://sellercentral.amazon.com.br/**', (route) => route.abort());
  return amazon;
}

/**
 * Register the backend stubs. MUST run BEFORE `page.goto`. The D11 belt is
 * not here: the suite installs it for every case ({@link instalarCintoAmazon}).
 *
 * The backend routes are matched on the PATHNAME (a predicate, not a glob): the
 * base URL is whatever `NEXT_PUBLIC_AMAZON_URL` the lane builds with (the
 * client's localhost fallback when unset). Playwright answers the CORS
 * preflight itself before any handler runs (the `pedidos-etiqueta-shopee`
 * precedent), so only the real requests land here. An unexpected call is
 * recorded and answered 409, so the assertion names it rather than a stub that
 * quietly accepted it.
 */
async function instalarStubsAmazon(
  page: Page,
  baseURL: string | undefined,
  contaId: string,
  opcoes: OpcoesStubsAmazon,
): Promise<StubsAmazon> {
  const stubs: StubsAmazon = {
    status: [],
    start: [],
    inesperadas: [],
    consentimento: [],
  };

  await page.route(
    (url) => url.pathname === CONSENTIMENTO_LOCAL,
    async (route) => {
      stubs.consentimento.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>Consentimento simulado</title><h1>Consentimento simulado</h1>',
      });
    },
  );

  const base = `${CONTA_PATH}${encodeURIComponent(contaId)}`;
  await page.route(
    (url) => url.pathname.startsWith(CONTA_PATH),
    async (route) => {
      const chamada = await chamadaDe(route);
      const json = (status: number, corpo: unknown) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          headers: { 'Cache-Control': 'no-store' },
          body: JSON.stringify(corpo),
        });

      if (chamada.method === 'GET' && chamada.pathname === base) {
        stubs.status.push(chamada);
        return json(200, opcoes.status);
      }
      if (
        chamada.method === 'POST' &&
        chamada.pathname === `${base}/oauth/start` &&
        opcoes.start !== undefined &&
        stubs.start.length === 0
      ) {
        stubs.start.push(chamada);
        if (opcoes.start === 'consentimento-local') {
          const resposta: RespostaInicioOAuthAmazon = {
            authorizeUrl: new URL(`${CONSENTIMENTO_LOCAL}?conta=${contaId}`, baseURL).toString(),
          };
          return json(200, resposta);
        }
        return json(opcoes.start.status, opcoes.start.corpo);
      }
      stubs.inesperadas.push(chamada);
      console.warn('[e2e amazon] chamada inesperada ao backend', {
        method: chamada.method,
        pathname: chamada.pathname,
      });
      return json(409, { error: 'Chamada inesperada (stub do e2e).', code: 'E2E_INESPERADA' });
    },
  );
  return stubs;
}

/** The connection panel — a named region, so nothing in the form below can match. */
function painelAmazon(page: Page): Locator {
  return page.getByRole('region', { name: 'Conexão com a Amazon' });
}

/** A Mantine notification (role `alert`) carrying this text. */
async function expectNotificacao(page: Page, texto: string | RegExp): Promise<void> {
  await expect(page.getByRole('alert').filter({ hasText: texto }).first()).toBeVisible({
    timeout: 15_000,
  });
}

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
  // The D11 belt's record for the running case (see `instalarCintoAmazon`).
  let requisicoesAmazon: string[] = [];

  // Every case, not only the panel ones: each conta page mounts the live
  // panel, whose button a future CRUD case could click.
  test.beforeEach(async ({ page }) => {
    requisicoesAmazon = await instalarCintoAmazon(page);
  });

  test.afterEach(() => {
    expect(requisicoesAmazon).toEqual([]);
  });

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

  test('says honestly that the channel only registers and connects the conta', async ({ page }) => {
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

  // ---- The connection panel, against a stubbed backend (row 3 is untouched above). ----

  test('shows a connected conta and reconnects through the consent URL the backend answered', async ({
    page,
    baseURL,
  }) => {
    const stubs = await instalarStubsAmazon(page, baseURL, row(3), {
      status: STATUS_CONECTADA,
      start: 'consentimento-local',
    });

    await page.goto(`/canais/amazon/${row(3)}`);
    const painel = painelAmazon(page);
    await expect(painel.getByText('Conectada', { exact: true })).toBeVisible({ timeout: 15_000 });
    // The server's civil dates, split — never re-derived from the browser's clock.
    await expect(
      painel.getByText('Autorizada em 10/03/2026 · reautorizar até 10/03/2027'),
    ).toBeVisible();
    // A healthy conta: none of the three alerts.
    await expect(painel.getByRole('alert')).toHaveCount(0);

    await painel.getByRole('button', { name: 'Reautenticar' }).click();
    await page.waitForURL((url) => url.pathname === CONSENTIMENTO_LOCAL, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Consentimento simulado' })).toBeVisible();

    expect(stubs.start).toHaveLength(1);
    const [start] = stubs.start;
    expect(start?.method).toBe('POST');
    expect(start?.temCorpo).toBe(false);
    expect(start?.authorization).toMatch(/^Bearer \S+$/);
    expect(stubs.consentimento).toHaveLength(1);
    expect(stubs.inesperadas).toEqual([]);
  });

  test('warns ahead of the reauthorization date, pointing at this panel', async ({
    page,
    baseURL,
  }) => {
    await instalarStubsAmazon(page, baseURL, row(3), {
      status: { ...STATUS_CONECTADA, diasParaReautorizar: 12 },
    });

    await page.goto(`/canais/amazon/${row(3)}`);
    const painel = painelAmazon(page);
    await expect(painel.getByText('Reautorização próxima')).toBeVisible({ timeout: 15_000 });
    await expect(painel.getByText(/vence em 12 dia\(s\) \(10\/03\/2027\)/)).toBeVisible();
    await expect(painel.getByText(/Clique em Reautenticar abaixo/)).toBeVisible();
  });

  test('shows a parked conta in red, with the refusal date and status', async ({
    page,
    baseURL,
  }) => {
    await instalarStubsAmazon(page, baseURL, row(3), {
      status: { ...STATUS_CONECTADA, reconexaoPendente: { desde: '2026-10-01', status: 400 } },
    });

    await page.goto(`/canais/amazon/${row(3)}`);
    const painel = painelAmazon(page);
    await expect(painel.getByText('Autorização recusada pela Amazon')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      painel.getByText(/A Amazon recusou a autorização desta conta em 01\/10\/2026 \(HTTP 400\)/),
    ).toBeVisible();
    // Red — the title's claim — read from the Alert's inline Mantine variables.
    await expect(
      painel.getByRole('alert').filter({ hasText: 'Autorização recusada pela Amazon' }),
    ).toHaveAttribute('style', /--mantine-color-red-/);
  });

  test('with the read switch off, Conectar conta shows the refusal and stays on the page', async ({
    page,
    baseURL,
  }) => {
    const stubs = await instalarStubsAmazon(page, baseURL, row(3), {
      status: STATUS_DESLIGADA,
      start: {
        status: 503,
        corpo: {
          error: 'As chamadas à Amazon estão desligadas neste backend.',
          code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS,
        },
      },
    });

    await page.goto(`/canais/amazon/${row(3)}`);
    const painel = painelAmazon(page);
    await expect(painel.getByText('Integração desligada')).toBeVisible({ timeout: 15_000 });
    await expect(painel.getByText('Não conectada', { exact: true })).toBeVisible();

    await painel.getByRole('button', { name: 'Conectar conta' }).click();
    await expectNotificacao(page, /Nada foi enviado à Amazon nem salvo/);

    expect(new URL(page.url()).pathname).toBe(`/canais/amazon/${row(3)}`);
    expect(stubs.start).toHaveLength(1);
    expect(stubs.consentimento).toEqual([]);
    expect(stubs.inesperadas).toEqual([]);
  });

  test('toasts a wrong-seller callback return with its pt-BR copy', async ({ page, baseURL }) => {
    const stubs = await instalarStubsAmazon(page, baseURL, row(3), { status: STATUS_CONECTADA });

    await page.goto(`/canais/amazon/${row(3)}?amazon=error&reason=vendedor_diferente`);
    await expectNotificacao(
      page,
      'Esta conta já está ligada a outro vendedor da Amazon; para trocar de vendedor, crie outra conta.',
    );
    expect(stubs.inesperadas).toEqual([]);
  });

  test('toasts a list-page callback return (a state that did not verify)', async ({
    page,
    baseURL,
  }) => {
    const stubs = await instalarStubsAmazon(page, baseURL, row(3), { status: STATUS_CONECTADA });

    await page.goto('/canais/amazon?amazon=error&reason=bad_state');
    await expectNotificacao(page, /cada tentativa vale uma vez só/);
    expect(stubs.inesperadas).toEqual([]);
  });
});
