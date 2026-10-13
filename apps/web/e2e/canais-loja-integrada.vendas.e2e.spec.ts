import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { somarDiasCivis } from '@delfrance/core/datetime';
import {
  CODIGO_ERRO_LI,
  SITUACAO_VALIDADE_TOKEN_LI,
  type RespostaCredencialLojaIntegrada,
  type StatusContaLojaIntegrada,
  janelaDeValidadeTokenLi,
} from '@delfrance/schemas';
import {
  cleanupLojaIntegradaFixtures,
  docExistsByName,
  e2ePrefix,
  seedLojaIntegradaFixtures,
  seedShopeeFixtures,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowHidden, expectRowVisible } from './helpers/table-view';
import {
  clickSave,
  confirmDelete,
  expectFieldAfterReload,
  fillField,
  selectFieldWithSearch,
} from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/canais/loja-integrada` TableView + ObjectView
 * flow, driven by `integracaoSchema` filtered to `tipo == 3` (Loja Integrada).
 * Mirrors the Shopee suite; row lookup leans on the run-scoped `nome` prefix.
 *
 * The `apps/loja-integrada` backend does NOT run in this suite. The credential
 * panel on `[id]` talks to it, so its cases STUB the backend with `page.route`
 * (below) — the real routes, the Admin write and the cascade are covered by the
 * backend's offline tests. The CRUD cases leave the panel unstubbed and assert
 * nothing about it: its read goes wherever the build points, beside the form.
 */

/** Every conta route hangs off this path, whatever host the build points at. */
const CONTA_PATH = '/api/marketplace/loja-integrada/conta/';

/** A fake Personal Token, so a leak is greppable. Never a real credential. */
const TOKEN_E2E = 'e2e-li-token-sentinela-5d1c8e3a7b9f2046c1e8d3b5a7f90c2e';

/** The stubbed credential's version (µs) — what the first write must echo. */
const VERSAO_STUB = 1_790_000_000_123_456;

/** The status a stubbed GET answers: a token saved yesterday, ~2 months left. */
function statusComToken(
  janela: { desde: string },
  patch: Partial<StatusContaLojaIntegrada> = {},
): StatusContaLojaIntegrada {
  return {
    configurado: true,
    expiraEm: somarDiasCivis(janela.desde, 60),
    diasParaExpirar: 59,
    situacaoValidade: SITUACAO_VALIDADE_TOKEN_LI.ok,
    atualizadoEmMs: Date.now() - 86_400_000,
    versaoCredencialUs: VERSAO_STUB,
    reconexaoPendente: null,
    ...patch,
  };
}

/** One request the stubs saw. */
interface ChamadaLi {
  readonly method: string;
  readonly pathname: string;
  readonly authorization: string | undefined;
  readonly corpo: unknown;
}

interface StubsLi {
  /** Every status GET, in order. */
  readonly status: ChamadaLi[];
  /** Every save PUT, in order. */
  readonly salvar: ChamadaLi[];
  /** Anything else that reached a conta route — each answered 409. */
  readonly inesperadas: ChamadaLi[];
  /** EVERY request URL the page made, for the "never in a URL" check. */
  readonly urls: string[];
}

interface OpcoesStubsLi {
  /** What the status GET answers, or `'inalcancavel'` to refuse the connection. */
  readonly status: StatusContaLojaIntegrada | 'inalcancavel';
  /** The FIRST save's answer; a second save is unexpected. */
  readonly salvar?: { readonly status: number; readonly corpo: unknown };
}

async function chamadaDe(route: Route): Promise<ChamadaLi> {
  const req = route.request();
  const corpo: unknown = req.postData() === null ? undefined : req.postDataJSON();
  return {
    method: req.method(),
    pathname: new URL(req.url()).pathname,
    authorization: (await req.allHeaders())['authorization'],
    corpo,
  };
}

/**
 * Register the backend stubs. MUST run BEFORE `page.goto`.
 *
 * Matched on the PATHNAME (a predicate, not a glob): the base URL is whatever
 * `NEXT_PUBLIC_LOJA_INTEGRADA_URL` the lane builds with. Playwright answers the
 * CORS preflight itself before any handler runs (the `pedidos-etiqueta-shopee`
 * precedent), so only the real requests land here. An unexpected call is
 * recorded and answered 409, so the assertion names it rather than a stub that
 * quietly accepted it.
 */
async function instalarStubsLi(
  page: Page,
  contaId: string,
  opcoes: OpcoesStubsLi,
): Promise<StubsLi> {
  const stubs: StubsLi = { status: [], salvar: [], inesperadas: [], urls: [] };
  page.on('request', (req) => stubs.urls.push(req.url()));
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
        if (opcoes.status === 'inalcancavel') return route.abort('connectionrefused');
        return json(200, opcoes.status);
      }
      if (
        chamada.method === 'PUT' &&
        chamada.pathname === `${base}/credencial` &&
        opcoes.salvar !== undefined &&
        stubs.salvar.length === 0
      ) {
        stubs.salvar.push(chamada);
        return json(opcoes.salvar.status, opcoes.salvar.corpo);
      }
      stubs.inesperadas.push(chamada);
      console.warn('[e2e loja-integrada] chamada inesperada ao backend', {
        method: chamada.method,
        pathname: chamada.pathname,
      });
      return json(409, { error: 'Chamada inesperada (stub do e2e).', code: 'E2E_INESPERADA' });
    },
  );
  return stubs;
}

/** The credential panel — a named region, so nothing in the form below can match. */
function painelLi(page: Page): Locator {
  return page.getByRole('region', { name: 'Credencial da Loja Integrada' });
}

/** Pick a civil date in the real calendar (the panel labels each day DD/MM/AAAA). */
async function escolherData(page: Page, painel: Locator, dataCivil: string): Promise<void> {
  const [ano, mes, dia] = dataCivil.split('-');
  await painel.getByLabel('Validade do token').click();
  await page.getByRole('button', { name: `${dia}/${mes}/${ano}`, exact: true }).click();
}
test.describe.serial('Canais Loja Integrada e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('lji');
  // A second prefix for the near-miss conta of ANOTHER channel. The seed writes
  // `<prefix>-NNN` whatever the tipo, so reusing `prefix` would overwrite an LI
  // row instead of adding a Shopee one. `cleanupLojaIntegradaFixtures(prefix)`
  // still sweeps it: the cleanup is by name prefix, not by tipo.
  const outroPrefix = `${prefix}-outro`;
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;
  const refLabel = `${prefix}-ref`;

  test.beforeAll(async ({ browser }) => {
    // Compiling 3 cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedLojaIntegradaFixtures(prefix, 5),
      seedShopeeFixtures(outroPrefix, 1),
      warmRoutes(browser, [
        '/canais/loja-integrada',
        '/canais/loja-integrada/novo',
        '/canais/loja-integrada/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupLojaIntegradaFixtures(prefix);
  });

  test('TableView lists Loja Integrada contas only', async ({ page }) => {
    await page.goto('/canais/loja-integrada');
    await expect(page.getByRole('heading', { name: 'Loja Integrada' })).toBeVisible();
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

  test('says honestly that the channel only stores the conta and its token', async ({ page }) => {
    await page.goto('/canais/loja-integrada');
    await expect(page.getByText('O que esta tela faz hoje')).toBeVisible();
    await expect(
      page.getByText('validado na Loja Integrada no momento em que é salvo', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText('nada é sincronizado', { exact: false })).toBeVisible();
  });

  test('navigates to the new-conta page', async ({ page }) => {
    await page.goto('/canais/loja-integrada');
    await page.getByRole('link', { name: 'Nova conta' }).click();
    await expect(page).toHaveURL(/\/canais\/loja-integrada\/novo$/);
    await expect(page.getByRole('heading', { name: 'Nova conta Loja Integrada' })).toBeVisible();
  });

  test('creates a new conta and lands on its edit page', async ({ page }) => {
    const nome = `${prefix}-nova`;
    await page.goto('/canais/loja-integrada/novo');
    await fillField(page, 'Nome', nome);
    // The dropdowns cap at 15 docs: type to trigger the server-side search so
    // the run-scoped fixture refs are found regardless of their position.
    await selectFieldWithSearch(page, 'Filial', `${refLabel}-filial`);
    await selectFieldWithSearch(page, 'Tabela de preços', `${refLabel}-lista`);
    await selectFieldWithSearch(page, 'Depósito', `${refLabel}-deposito`);
    await clickSave(page, 'Criar');

    // onSaved does router.replace('/canais/loja-integrada/<id>').
    await page.waitForURL(
      (url) =>
        /^\/canais\/loja-integrada\/[^/]+$/.test(url.pathname) &&
        url.pathname !== '/canais/loja-integrada/novo',
      { timeout: 15_000 },
    );
    await expect.poll(() => docExistsByName('integracao', nome), { timeout: 15_000 }).toBe(true);
    await expect(page.getByRole('heading', { name: 'Conta Loja Integrada' })).toBeVisible();

    await page.goto('/canais/loja-integrada');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, nome);
  });

  test('opens an existing conta from the list', async ({ page }) => {
    await page.goto('/canais/loja-integrada');
    await applyTextFilter(page, 'Nome', prefix);
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/canais\/loja-integrada\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('edits a conta and saves', async ({ page }) => {
    await page.goto(`/canais/loja-integrada/${row(4)}`);
    await fillField(page, 'Nome', `${prefix}-004-editada`);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/canais\/loja-integrada$/, { timeout: 15_000 });

    await page.goto(`/canais/loja-integrada/${row(4)}`);
    await expectFieldAfterReload(page, 'Nome', `${prefix}-004-editada`);
  });

  test('deletes a conta through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/canais/loja-integrada/${row(5)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/canais\/loja-integrada$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowHidden(page, row(5));
  });

  // ---- The credential panel, against a stubbed backend (row 3 is untouched above). ----

  test('saves a token with one PUT carrying the version on screen, and clears the field', async ({
    page,
  }) => {
    const janela = janelaDeValidadeTokenLi(Date.now());
    const resposta: RespostaCredencialLojaIntegrada = {
      ...statusComToken(janela, {
        expiraEm: janela.desde,
        diasParaExpirar: 0,
        situacaoValidade: SITUACAO_VALIDADE_TOKEN_LI.expirando,
        atualizadoEmMs: Date.now(),
        versaoCredencialUs: VERSAO_STUB + 1,
      }),
      reconexaoResolvida: false,
    };
    const stubs = await instalarStubsLi(page, row(3), {
      status: statusComToken(janela),
      salvar: { status: 200, corpo: resposta },
    });

    await page.goto(`/canais/loja-integrada/${row(3)}`);
    const painel = painelLi(page);
    await expect(painel.getByText(/^Configurado — validado ao salvar em/)).toBeVisible({
      timeout: 15_000,
    });

    // Padded the way a paste often is: the body must carry it trimmed.
    await painel.getByLabel('Personal Token').fill(`  ${TOKEN_E2E}  `);
    await escolherData(page, painel, janela.desde);
    // While the field HOLDS the token: `page.content()` serialises attributes,
    // so a token mirrored into the input's `value` attribute shows up here.
    expect(await page.content()).not.toContain(TOKEN_E2E);
    await painel.getByRole('button', { name: 'Validar e salvar' }).click();

    await expect(painel.getByText(/^Token validado e salvo\./)).toBeVisible({ timeout: 15_000 });
    expect(stubs.salvar).toHaveLength(1);
    const [put] = stubs.salvar;
    expect(put?.method).toBe('PUT');
    // Exactly the route's three keys: the trimmed token, a civil date, and the
    // version of the status the panel showed.
    expect(put?.corpo).toEqual({
      token: TOKEN_E2E,
      expiraEm: janela.desde,
      versaoEsperada: VERSAO_STUB,
    });
    expect(put?.authorization).toMatch(/^Bearer \S+$/);
    // The token travelled in that body and nowhere else.
    expect(stubs.urls.filter((u) => u.includes(TOKEN_E2E))).toEqual([]);
    await expect(painel.getByLabel('Personal Token')).toHaveValue('');
    expect(stubs.inesperadas).toEqual([]);
  });

  const VEREDITOS = [
    {
      nome: '422 refused by Loja Integrada',
      status: 422,
      corpo: { error: 'recusado', code: CODIGO_ERRO_LI.tokenRecusado, status: 401 },
      copia: /recusou este token \(HTTP 401\)/,
      mantemToken: false,
      releStatus: false,
    },
    {
      nome: '422 malformed token',
      status: 422,
      corpo: { error: 'malformado', code: CODIGO_ERRO_LI.tokenInvalido, status: null },
      copia: /Nada foi enviado à Loja Integrada/,
      mantemToken: false,
      releStatus: false,
    },
    {
      nome: '502 inconclusive validation',
      status: 502,
      corpo: { error: 'inconclusivo', code: CODIGO_ERRO_LI.validacaoInconclusiva, status: 503 },
      copia: /Não foi possível validar o token agora/,
      mantemToken: true,
      releStatus: false,
    },
    {
      nome: '409 credential changed underneath',
      status: 409,
      corpo: { error: 'alterada', code: CODIGO_ERRO_LI.credencialAlterada },
      copia: /mudou depois que esta tela a leu/,
      mantemToken: true,
      releStatus: true,
    },
  ] as const;

  for (const v of VEREDITOS) {
    test(`a ${v.nome}: its copy, and the token field ${v.mantemToken ? 'kept' : 'cleared'}`, async ({
      page,
    }) => {
      const janela = janelaDeValidadeTokenLi(Date.now());
      const stubs = await instalarStubsLi(page, row(3), {
        status: statusComToken(janela),
        salvar: { status: v.status, corpo: v.corpo },
      });

      await page.goto(`/canais/loja-integrada/${row(3)}`);
      const painel = painelLi(page);
      await expect(painel.getByText(/^Configurado — validado ao salvar em/)).toBeVisible({
        timeout: 15_000,
      });
      await painel.getByLabel('Personal Token').fill(TOKEN_E2E);
      await escolherData(page, painel, janela.desde);
      await painel.getByRole('button', { name: 'Validar e salvar' }).click();

      await expect(painel.getByText(v.copia)).toBeVisible({ timeout: 15_000 });
      await expect(painel.getByLabel('Personal Token')).toHaveValue(v.mantemToken ? TOKEN_E2E : '');
      // With the verdict on screen — and, where it is kept, the token still in
      // the field — the serialised page (attributes included) never holds it.
      expect(await page.content()).not.toContain(TOKEN_E2E);
      expect(stubs.salvar).toHaveLength(1);
      // Only a changed credential re-reads the status; a verdict that wrote
      // nothing must not quietly adopt another operator's version.
      await expect.poll(() => stubs.status.length).toBe(v.releStatus ? 2 : 1);
      expect(stubs.inesperadas).toEqual([]);
    });
  }

  test('shows the reconexão alert for a conta Loja Integrada refused', async ({ page }) => {
    const janela = janelaDeValidadeTokenLi(Date.now());
    await instalarStubsLi(page, row(3), {
      status: statusComToken(janela, {
        reconexaoPendente: { desdeMs: Date.now() - 3_600_000, status: 401 },
      }),
    });

    await page.goto(`/canais/loja-integrada/${row(3)}`);
    const painel = painelLi(page);
    await expect(painel.getByText('Reconexão pendente')).toBeVisible({ timeout: 15_000 });
    await expect(painel.getByText(/A Loja Integrada recusou o token \(HTTP 401\)/)).toBeVisible();
  });

  test('offers a retry when the backend cannot be reached, and keeps the save disabled', async ({
    page,
  }) => {
    await instalarStubsLi(page, row(3), { status: 'inalcancavel' });

    await page.goto(`/canais/loja-integrada/${row(3)}`);
    const painel = painelLi(page);
    await expect(
      painel.getByText('Não foi possível contatar o backend da Loja Integrada.'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(painel.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
    await expect(painel.getByRole('button', { name: 'Validar e salvar' })).toBeDisabled();
  });
});
