import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { somarDiasCivis } from '@delfrance/core/datetime';
import {
  ACAO_IMPORTACAO_LI,
  ACAO_ITEM_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  CATEGORIAS_IMPORTACAO_LI,
  CODIGO_ERRO_LI,
  type EntradaRespostaRevisaoFiscalLi,
  FASE_IMPORTACAO_LI,
  FOTOS_IMPORTACAO_LI,
  type ItemRespostaImportacaoLi,
  MODO_IMPORTACAO_LI,
  MOTIVO_REVISAO_FISCAL_LI,
  PENDENCIA_IMPORTACAO_LI,
  type RespostaCredencialLojaIntegrada,
  type RespostaImportacaoLi,
  SITUACAO_ERP_ITEM_LI,
  SITUACAO_VALIDADE_TOKEN_LI,
  STATUS_IMPORTACAO_LI,
  type StatusContaLojaIntegrada,
  TIPO_PRODUTO_LI,
  janelaDeValidadeTokenLi,
  opcoesImportacaoLiSchema,
} from '@delfrance/schemas';
import {
  cleanupLojaIntegradaFixtures,
  docExistsByName,
  e2ePrefix,
  seedLojaIntegradaFixtures,
  seedShopeeFixtures,
} from './_helpers/seed-data';
import {
  applyTextFilter,
  expectRowHidden,
  expectRowVisible,
  selectRowByText,
} from './helpers/table-view';
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
 * panel on `[id]` and the product import on the list (master plan step 9: the
 * start, the progress card, Cancelar, the result view) talk to it, so their
 * cases STUB the backend with `page.route` (below) — the real routes, the job,
 * the Admin writes and the cascade are covered by the backend's offline tests,
 * and the cards, the dialog and the result view by their unit suites. The CRUD
 * cases leave the panel unstubbed and assert nothing about it: its read goes
 * wherever the build points, beside the form.
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
  /** The conta page's product-import list reads (answered with no import). */
  readonly importacoes: ChamadaLi[];
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
  const stubs: StubsLi = { status: [], salvar: [], importacoes: [], inesperadas: [], urls: [] };
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
      // The conta page also shows the conta's product imports: none here.
      if (chamada.method === 'GET' && chamada.pathname === `${base}/importacoes`) {
        stubs.importacoes.push(chamada);
        return json(200, { importacoes: [] });
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

/* ---- The product import's stubs (master plan step 9) ---- */

/** The fixture job ids the import stubs hand out — the job-id grammar the routes accept. */
const JOB_EM_CURSO = 'job-e2e-em-curso';
const JOB_SIMULACAO = 'job-e2e-simulacao';
const JOB_SELECIONADOS = 'job-e2e-selecionados';
const JOB_IMPORTACAO = 'job-e2e-importacao';

/** One job as the real route projects it (`respostaImportacaoLiSchema`): a running Importar. */
function jobImportacao(over: Partial<RespostaImportacaoLi> = {}): RespostaImportacaoLi {
  const agora = Date.now();
  return {
    jobId: JOB_EM_CURSO,
    integracaoId: 'conta-e2e',
    status: STATUS_IMPORTACAO_LI.executando,
    fase: FASE_IMPORTACAO_LI.familias,
    motivo: null,
    modo: MODO_IMPORTACAO_LI.aplicar,
    alvo: ALVO_IMPORTACAO_LI.todos,
    acao: ACAO_IMPORTACAO_LI.soVincular,
    categorias: CATEGORIAS_IMPORTACAO_LI.soVincular,
    fotos: FOTOS_IMPORTACAO_LI.naoImportar,
    selecionados: 0,
    simulacaoId: null,
    iniciadoEmMs: agora - 60_000,
    atualizadoEmMs: agora,
    concluidoEmMs: null,
    contadores: {
      familias: 40,
      vinculados: 12,
      criados: 3,
      completados: 2,
      semMudanca: 23,
      pendenciasAcionaveis: 1,
      pendenciasInformativas: 4,
      fotos: 0,
      falhas: 0,
    },
    listagem: { paginas: 1, linhas: 40, totalLi: 40, divergente: false },
    pausas429: 0,
    fotosIndisponiveis: false,
    ...over,
  };
}

/** One report row as the items route answers it. The store ids are obviously fake. */
function itemImportacao(
  liId: number,
  over: Partial<ItemRespostaImportacaoLi> = {},
): ItemRespostaImportacaoLi {
  return {
    liId,
    tipo: TIPO_PRODUTO_LI.normal,
    sku: `SKU-E2E-${String(liId)}`,
    nome: `Produto e2e ${String(liId)}`,
    filhos: 0,
    situacaoErp: SITUACAO_ERP_ITEM_LI.ausente,
    erpId: null,
    acao: ACAO_ITEM_IMPORTACAO_LI.criar,
    aplicada: false,
    camposPreenchidos: [],
    categoriasCriadas: [],
    pendencias: [],
    atualizadoEmMs: Date.now(),
    ...over,
  };
}

interface StubsImportacaoLi {
  /** Every import call, in order. */
  readonly chamadas: ChamadaLi[];
  /** Anything else that reached a conta route — each answered 409. */
  readonly inesperadas: ChamadaLi[];
}

interface OpcoesStubsImportacaoLi {
  /** The conta's jobs, newest first: what the list answers, and what a job read finds. */
  readonly jobs: readonly RespostaImportacaoLi[];
  /** What a start answers. A 202 adds its job, pending, built from the start body. */
  readonly inicio?: { readonly status: number; readonly corpo: unknown };
  /** Each job's report. */
  readonly itens?: Readonly<Record<string, readonly ItemRespostaImportacaoLi[]>>;
  /** Each job's tax-review list. */
  readonly revisao?: Readonly<Record<string, readonly EntradaRespostaRevisaoFiscalLi[]>>;
}

/**
 * The import routes of ONE conta, stubbed like the credential ones: on the
 * PATHNAME, before `page.goto`, an unexpected call recorded and answered 409.
 * The stub keeps the jobs as the real backend would — a 202 start adds its job
 * (the body read through the route's own strict schema, a 400 otherwise), a
 * cancel ends one — so the card's polls read the state the page caused.
 */
async function instalarStubsImportacaoLi(
  page: Page,
  contaId: string,
  opcoes: OpcoesStubsImportacaoLi,
): Promise<StubsImportacaoLi> {
  const stubs: StubsImportacaoLi = { chamadas: [], inesperadas: [] };
  const jobs: RespostaImportacaoLi[] = opcoes.jobs.map((j) => ({ ...j, integracaoId: contaId }));
  const base = `${CONTA_PATH}${encodeURIComponent(contaId)}/importacoes`;

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
      const { method, pathname } = chamada;

      if (pathname === base && method === 'GET') {
        stubs.chamadas.push(chamada);
        return json(200, { importacoes: jobs });
      }
      if (pathname === base && method === 'POST' && opcoes.inicio !== undefined) {
        stubs.chamadas.push(chamada);
        const { status, corpo } = opcoes.inicio;
        const jobId =
          typeof corpo === 'object' && corpo !== null && 'jobId' in corpo ? corpo.jobId : null;
        if (status === 202 && typeof jobId === 'string') {
          const lido = opcoesImportacaoLiSchema.safeParse(chamada.corpo);
          if (!lido.success) {
            return json(400, { error: 'Corpo inválido.', code: CODIGO_ERRO_LI.corpoInvalido });
          }
          const { selecionados, ...opcoesDoJob } = lido.data;
          jobs.unshift(
            jobImportacao({
              ...opcoesDoJob,
              jobId,
              integracaoId: contaId,
              status: STATUS_IMPORTACAO_LI.pendente,
              selecionados: selecionados.length,
            }),
          );
        }
        return json(status, corpo);
      }
      const [jobId, recurso, ...resto] = pathname.startsWith(`${base}/`)
        ? pathname.slice(base.length + 1).split('/')
        : [];
      const indice = jobs.findIndex((j) => j.jobId === jobId);
      const job = jobs[indice];
      if (job !== undefined && resto.length === 0) {
        if (method === 'GET' && recurso === undefined) {
          stubs.chamadas.push(chamada);
          return json(200, job);
        }
        if (method === 'POST' && recurso === 'cancelar') {
          stubs.chamadas.push(chamada);
          const cancelado: RespostaImportacaoLi = {
            ...job,
            status: STATUS_IMPORTACAO_LI.cancelado,
            concluidoEmMs: Date.now(),
          };
          jobs[indice] = cancelado;
          return json(200, cancelado);
        }
        if (method === 'GET' && recurso === 'itens') {
          stubs.chamadas.push(chamada);
          return json(200, { itens: opcoes.itens?.[job.jobId] ?? [], proximo: null });
        }
        if (method === 'GET' && recurso === 'revisao') {
          stubs.chamadas.push(chamada);
          return json(200, { entradas: opcoes.revisao?.[job.jobId] ?? [], proximo: null });
        }
      }
      stubs.inesperadas.push(chamada);
      console.warn('[e2e loja-integrada] chamada inesperada ao backend', { method, pathname });
      return json(409, { error: 'Chamada inesperada (stub do e2e).', code: 'E2E_INESPERADA' });
    },
  );
  return stubs;
}

/** The rail's import panel — a named region, so nothing in the table can match. */
function painelImportacoes(page: Page): Locator {
  return page.getByRole('region', { name: 'Importações de produtos' });
}

/** Click a SegmentedControl segment: its radio is visually hidden, its label is not. */
async function escolherSegmento(escopo: Locator, rotulo: string): Promise<void> {
  const radio = escopo.getByRole('radio', { name: rotulo, exact: true });
  const id = await radio.getAttribute('id');
  expect(id, `segment "${rotulo}" has no id to bind a label to`).toBeTruthy();
  await escopo.locator(`label[for="${id ?? ''}"]`).click();
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

  test('explains what the channel screen does today', async ({ page }) => {
    await page.goto('/canais/loja-integrada');
    await expect(page.getByText('O que esta tela faz hoje')).toBeVisible();
    await expect(
      page.getByText('validado na Loja Integrada no momento em que é salvo', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText('mapeamento do frete', { exact: false })).toBeVisible();
    await expect(
      page.getByText('a importação só funciona depois da migração para este sistema', {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('Enviar estoque e enviar preço não existem neste canal', { exact: false }),
    ).toBeVisible();
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

  // ---- The product import, against a stubbed backend (row 1 is untouched above). ----

  /** The list narrowed to this run, row 1 selected: the rail's panel then reads its jobs. */
  async function selecionarConta(page: Page, stubs: StubsImportacaoLi): Promise<Locator> {
    await page.goto('/canais/loja-integrada');
    await applyTextFilter(page, 'Nome', prefix);
    await selectRowByText(page, row(1));
    await expect
      .poll(() => stubs.chamadas.filter((c) => c.method === 'GET').length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    return painelImportacoes(page);
  }

  test('a start refused with the store calls off shows the after-the-migration copy and no job card', async ({
    page,
  }) => {
    const stubs = await instalarStubsImportacaoLi(page, row(1), {
      jobs: [],
      inicio: {
        status: 503,
        corpo: {
          error: 'As chamadas à Loja Integrada estão desligadas.',
          code: CODIGO_ERRO_LI.chamadasDesligadas,
        },
      },
    });
    const painel = await selecionarConta(page, stubs);

    await page.getByRole('button', { name: 'Importar produtos da loja', exact: true }).click();
    const dialogo = page.getByRole('dialog', { name: 'Importar produtos da loja' });
    await expect(dialogo.getByText(row(1))).toBeVisible();
    await dialogo.getByRole('button', { name: 'Iniciar simulação' }).click();

    await expect(painel.getByText(/só funciona depois da migração para este sistema/)).toBeVisible({
      timeout: 15_000,
    });
    const inicios = stubs.chamadas.filter((c) => c.method === 'POST');
    expect(inicios).toHaveLength(1);
    // The dialog's defaults — the options that change the least — as the strict body.
    expect(inicios[0]?.corpo).toEqual({
      modo: MODO_IMPORTACAO_LI.simular,
      alvo: ALVO_IMPORTACAO_LI.todos,
      acao: ACAO_IMPORTACAO_LI.soVincular,
      categorias: CATEGORIAS_IMPORTACAO_LI.soVincular,
      fotos: FOTOS_IMPORTACAO_LI.naoImportar,
      selecionados: [],
      simulacaoId: null,
    });
    expect(inicios[0]?.authorization).toMatch(/^Bearer \S+$/);
    // No job card: the conta's only card is the refused start's, with nothing
    // to open or cancel…
    await expect(
      painel.getByRole('button', { name: /^Dispensar Importação de produtos/ }),
    ).toHaveCount(1);
    await expect(painel.getByRole('button', { name: 'Ver resultado' })).toHaveCount(0);
    // …and no request ever named a job: the stub records one under
    // `<base>/<jobId>` whether it knows the job or not.
    const base = `${CONTA_PATH}${encodeURIComponent(row(1))}/importacoes/`;
    expect(
      [...stubs.chamadas, ...stubs.inesperadas].filter((c) => c.pathname.startsWith(base)),
    ).toEqual([]);
    expect(stubs.inesperadas).toEqual([]);
  });

  test('a running import shows its counters, and Cancelar posts to that job’s cancel route', async ({
    page,
  }) => {
    const stubs = await instalarStubsImportacaoLi(page, row(1), { jobs: [jobImportacao()] });
    const painel = await selecionarConta(page, stubs);

    await expect(painel.getByText('Em andamento')).toBeVisible({ timeout: 15_000 });
    await expect(painel.getByText('40 produtos da loja processados')).toBeVisible();
    await expect(
      painel.getByText('12 vinculados · 3 criados · 2 completados · 23 sem mudança'),
    ).toBeVisible();
    await expect(painel.getByText('1 pendência a resolver · 4 informativas')).toBeVisible();

    await painel
      .getByRole('button', { name: `Dispensar Importação de produtos de ${row(1)}` })
      .click();
    await page.getByRole('button', { name: 'Cancelar importação' }).click();

    await expect(
      painel.getByText('Importação cancelada. O que ela já gravou no ERP permanece.'),
    ).toBeVisible({ timeout: 15_000 });
    const cancelamentos = stubs.chamadas.filter((c) => c.method === 'POST');
    expect(cancelamentos).toHaveLength(1);
    expect(cancelamentos[0]?.pathname).toBe(
      `${CONTA_PATH}${encodeURIComponent(row(1))}/importacoes/${JOB_EM_CURSO}/cancelar`,
    );
    expect(cancelamentos[0]?.corpo).toBeUndefined();
    expect(stubs.inesperadas).toEqual([]);
  });

  test('from a finished Simular, "Importar selecionados" sends exactly the picked store ids with the Simular’s options', async ({
    page,
  }) => {
    const stubs = await instalarStubsImportacaoLi(page, row(1), {
      jobs: [
        jobImportacao({
          jobId: JOB_SIMULACAO,
          status: STATUS_IMPORTACAO_LI.concluido,
          modo: MODO_IMPORTACAO_LI.simular,
          acao: ACAO_IMPORTACAO_LI.completar,
          categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
          fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
          concluidoEmMs: Date.now(),
        }),
      ],
      inicio: { status: 202, corpo: { jobId: JOB_SELECIONADOS } },
      itens: {
        [JOB_SIMULACAO]: [
          itemImportacao(900_000_101, { tipo: TIPO_PRODUTO_LI.atributo, filhos: 2 }),
          itemImportacao(900_000_102, {
            situacaoErp: SITUACAO_ERP_ITEM_LI.encontrado,
            erpId: 'produto-e2e-102',
            acao: ACAO_ITEM_IMPORTACAO_LI.vincular,
          }),
          itemImportacao(900_000_103),
          itemImportacao(900_000_104, {
            tipo: TIPO_PRODUTO_LI.atributoOpcao,
            situacaoErp: SITUACAO_ERP_ITEM_LI.avulso,
            acao: ACAO_ITEM_IMPORTACAO_LI.nenhuma,
            pendencias: [
              {
                codigo: PENDENCIA_IMPORTACAO_LI.orfao,
                acionavel: false,
                liId: null,
                referencias: [],
              },
            ],
          }),
        ],
      },
    });
    const painel = await selecionarConta(page, stubs);

    await painel.getByRole('button', { name: 'Ver resultado' }).click({ timeout: 15_000 });
    const resultado = page.getByRole('dialog', { name: /Resultado da simulação/ });
    await expect(resultado.getByText('SKU-E2E-900000101')).toBeVisible({ timeout: 15_000 });
    // A loose row is never a family root: it gets no box.
    await expect(
      resultado.getByRole('checkbox', { name: 'Selecionar o produto da loja 900000104' }),
    ).toHaveCount(0);

    await resultado
      .getByRole('checkbox', { name: 'Selecionar o produto da loja 900000103' })
      .check();
    await resultado
      .getByRole('checkbox', { name: 'Selecionar o produto da loja 900000101' })
      .check();
    await resultado.getByRole('button', { name: 'Importar selecionados (2)' }).click();

    await expect(resultado).toHaveCount(0, { timeout: 15_000 });
    const inicios = stubs.chamadas.filter((c) => c.method === 'POST');
    expect(inicios).toHaveLength(1);
    expect(inicios[0]?.corpo).toEqual({
      modo: MODO_IMPORTACAO_LI.aplicar,
      alvo: ALVO_IMPORTACAO_LI.selecionados,
      acao: ACAO_IMPORTACAO_LI.completar,
      categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
      fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
      selecionados: [900_000_101, 900_000_103],
      simulacaoId: JOB_SIMULACAO,
    });
    // The new job's card follows it in the rail.
    await expect(painel.getByText(/Selecionados \(2\) · Completar/)).toBeVisible({
      timeout: 15_000,
    });
    expect(stubs.inesperadas).toEqual([]);
  });

  test('"Revisão fiscal" shows only the tax-review produtos of the import', async ({ page }) => {
    const stubs = await instalarStubsImportacaoLi(page, row(1), {
      jobs: [
        jobImportacao({
          jobId: JOB_IMPORTACAO,
          status: STATUS_IMPORTACAO_LI.concluido,
          concluidoEmMs: Date.now(),
        }),
      ],
      itens: {
        [JOB_IMPORTACAO]: [
          itemImportacao(900_000_201, {
            situacaoErp: SITUACAO_ERP_ITEM_LI.vinculado,
            erpId: 'produto-e2e-item',
            acao: ACAO_ITEM_IMPORTACAO_LI.vincular,
            aplicada: true,
          }),
        ],
      },
      revisao: {
        [JOB_IMPORTACAO]: [
          {
            produtoId: 'produto-e2e-revisao-1',
            motivos: [MOTIVO_REVISAO_FISCAL_LI.produtoCriado],
            liId: 900_000_202,
            desdeJobId: JOB_IMPORTACAO,
            desdeMs: Date.now(),
          },
          {
            produtoId: 'produto-e2e-revisao-2',
            motivos: [MOTIVO_REVISAO_FISCAL_LI.semCategoria],
            liId: null,
            desdeJobId: JOB_IMPORTACAO,
            desdeMs: Date.now(),
          },
        ],
      },
    });
    const painel = await selecionarConta(page, stubs);

    await painel.getByRole('button', { name: 'Ver resultado' }).click({ timeout: 15_000 });
    const resultado = page.getByRole('dialog', { name: /Resultado da importação/ });
    await expect(resultado.getByText('SKU-E2E-900000201')).toBeVisible({ timeout: 15_000 });
    // The list is read only once its filter is picked.
    expect(stubs.chamadas.filter((c) => c.pathname.endsWith('/revisao'))).toEqual([]);

    await escolherSegmento(resultado, 'Revisão fiscal');
    await expect(resultado.getByText('Produto criado pela importação')).toBeVisible({
      timeout: 15_000,
    });
    await expect(resultado.getByText('Ficou sem categoria')).toBeVisible();
    await expect(resultado.getByText('SKU-E2E-900000201')).toHaveCount(0);
    const links = resultado.getByRole('link');
    await expect(links).toHaveText(['produto-e2e-revisao-1', 'produto-e2e-revisao-2']);
    await expect(links.first()).toHaveAttribute('href', '/produtos/produto-e2e-revisao-1/editar');
    expect(stubs.chamadas.filter((c) => c.pathname.endsWith('/revisao'))).toHaveLength(1);
    expect(stubs.inesperadas).toEqual([]);
  });
});
