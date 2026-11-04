import { expect, test, type Page } from '@playwright/test';
import { IMPORTACAO_SHOPEE_STATUS, type ImportacaoShopeeStatus } from '@delfrance/schemas';
import type { MassImportStatusShopee } from '../lib/shopee/wire';
import { cleanupShopeeFixtures, e2ePrefix, seedShopeeFixtures } from './_helpers/seed-data';
import { applyTextFilter, deselectRowByText, selectRowByText } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the Shopee job cards on `/canais/shopee` (#1529, step
 * 21-5): the "Importar todos os anúncios" action in the list's rail, and the
 * card that follows the run. The cards, the panel, the cadence and the error map
 * are unit-tested next to them (`canais/shopee/_components/*.test.ts(x)`); this
 * proves what only the real page in a real browser shows:
 *
 *   - the action is gated on a selection of exactly ONE conta, and its dialog
 *     names that conta;
 *   - a start puts a card in the "Jobs em andamento" region that polls THAT job
 *     until it ends, and the body carries the default status filter;
 *   - a busy start (409 naming the running job) attaches the card to it instead
 *     of failing, and a reload brings the card back from `sessionStorage`.
 *
 * The apps/shopee backend does NOT run in this suite: every route the page calls
 * is stubbed on the PATHNAME (the base URL is whatever `NEXT_PUBLIC_SHOPEE_URL`
 * the lane builds with), answering the bodies the real routes build. A route
 * this spec does not know is answered 404 and recorded in `semStub`, which every
 * test asserts empty — nothing is ever forwarded to a live backend, and no job
 * document is written anywhere.
 */

const PREFIXO_ROTAS = '/api/marketplace/shopee/';

/** The fixture job ids the stubs hand out. */
const JOB_NOVO = 'job-e2e-novo';
const JOB_EM_ANDAMENTO = 'job-e2e-em-andamento';

/** The real route's 409 sentence (`importar-todos/route.ts`, `MSG_IMPORTACAO_EM_ANDAMENTO`). */
const MSG_IMPORTACAO_EM_ANDAMENTO =
  'Já existe uma importação em massa em andamento para esta conta.';

interface Chamada {
  readonly metodo: string;
  readonly rota: string;
  readonly jobId: string | null;
  readonly corpo: Record<string, unknown> | null;
}

interface Stubs {
  /** Every Shopee backend call the page made, in order. */
  readonly chamadas: Chamada[];
  /** Calls to a Shopee route this spec does not stub (answered 404, never forwarded). */
  readonly semStub: string[];
}

type Resposta = { readonly status: number; readonly corpo: unknown };

/** How the stubbed `importar-todos` answers a start. */
type Inicio = 'aceita' | 'em-andamento';

/** A request body, parsed — or a marker the body assertion will print. */
function corpoDaChamada(corpo: string | null): Record<string, unknown> | null {
  if (corpo === null) return null;
  try {
    return JSON.parse(corpo) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) return { corpoNaoJson: corpo };
    throw err;
  }
}

/** The status body the real route builds by name — every key, strict. */
function statusDaImportacao(status: ImportacaoShopeeStatus): MassImportStatusShopee {
  const agora = Date.now();
  const terminou = status !== IMPORTACAO_SHOPEE_STATUS.running;
  return {
    status,
    scanned: terminou ? 40 : 10,
    imported: terminou ? 12 : 3,
    created: terminou ? 5 : 1,
    skipped: terminou ? 28 : 7,
    kits: 0,
    failureCount: 0,
    failures: [],
    restante: terminou ? 0 : 30,
    varreduraExaurida: terminou,
    startedAt: agora - 60_000,
    updatedAt: agora,
    finishedAt: terminou ? agora : null,
    erro: null,
  };
}

/**
 * Register the stubs. MUST run BEFORE `page.goto`. Playwright answers the CORS
 * preflight itself (the backend is cross-origin), so only the real requests land
 * here. Routes registered on the page survive `page.reload()`.
 *
 * The status answers BY CALL INDEX for an accepted start — the first poll
 * `running`, every later one `completed` — so the card's progress to the end is
 * visible on screen, not only in a count. An attached job stays `running`.
 */
async function instalarStubs(page: Page, inicio: Inicio): Promise<Stubs> {
  const stubs: Stubs = { chamadas: [], semStub: [] };
  let consultas = 0;

  function responder(rota: string): Resposta | null {
    switch (rota) {
      case 'importar-todos':
        return inicio === 'aceita'
          ? { status: 202, corpo: { jobId: JOB_NOVO } }
          : {
              status: 409,
              corpo: {
                error: MSG_IMPORTACAO_EM_ANDAMENTO,
                code: 'SHOPEE_MASS_IMPORT_RUNNING',
                jobId: JOB_EM_ANDAMENTO,
              },
            };
      case 'importar-todos/status': {
        consultas += 1;
        const status =
          inicio === 'aceita' && consultas > 1
            ? IMPORTACAO_SHOPEE_STATUS.completed
            : IMPORTACAO_SHOPEE_STATUS.running;
        return { status: 200, corpo: statusDaImportacao(status) };
      }
      default:
        return null;
    }
  }

  await page.route(
    (url) => url.pathname.startsWith(PREFIXO_ROTAS),
    async (route) => {
      const pedido = route.request();
      const url = new URL(pedido.url());
      const rota = url.pathname.slice(PREFIXO_ROTAS.length);
      stubs.chamadas.push({
        metodo: pedido.method(),
        rota,
        jobId: url.searchParams.get('jobId'),
        corpo: corpoDaChamada(pedido.postData()),
      });
      let resposta = responder(rota);
      if (resposta === null) {
        stubs.semStub.push(`${pedido.method()} ${url.pathname}`);
        resposta = {
          status: 404,
          corpo: { error: 'Rota da Shopee sem stub neste e2e.', code: 'E2E_SEM_STUB' },
        };
      }
      await route.fulfill({
        status: resposta.status,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(resposta.corpo),
      });
    },
  );
  return stubs;
}

/** The jobIds the status polls asked for, in order. */
function jobsConsultados(stubs: Stubs): Array<string | null> {
  return stubs.chamadas.filter((c) => c.rota === 'importar-todos/status').map((c) => c.jobId);
}

/** Select ONE conta and start the import through the real dialog. */
async function iniciarImportacao(page: Page, prefix: string, conta: string): Promise<void> {
  await page.goto('/canais/shopee');
  await applyTextFilter(page, 'Nome', prefix);
  await selectRowByText(page, conta);
  await page.getByRole('button', { name: 'Importar todos os anúncios', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(conta)).toBeVisible();
  await dialog.getByRole('button', { name: 'Iniciar importação' }).click();
}

test.describe.serial('Canais Shopee e2e — job cards', () => {
  const prefix = e2ePrefix('shpjob');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async ({ browser }) => {
    // Compiling a cold route can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([seedShopeeFixtures(prefix, 2), warmRoutes(browser, ['/canais/shopee'])]);
  });

  test.afterAll(async () => {
    await cleanupShopeeFixtures(prefix);
  });

  test('the import accepts exactly one conta and its card follows the run to the end', async ({
    page,
  }) => {
    const stubs = await instalarStubs(page, 'aceita');
    await page.goto('/canais/shopee');
    await applyTextFilter(page, 'Nome', prefix);

    // Selection gating is pure UI — no backend call in any of these states.
    const importar = page.getByRole('button', { name: 'Importar todos os anúncios', exact: true });
    await expect(importar).toBeDisabled();
    await selectRowByText(page, row(1));
    await expect(importar).toBeEnabled();
    await selectRowByText(page, row(2));
    await expect(importar).toBeDisabled();
    await expect(importar).toHaveAttribute('title', 'Selecione apenas 1 registro');
    await deselectRowByText(page, row(2));
    await expect(importar).toBeEnabled();

    // No `confirm` on the action: the options dialog IS the confirmation.
    await importar.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('1 conta selecionada')).toBeVisible();
    await expect(dialog.getByText(row(1))).toBeVisible();
    await dialog.getByRole('button', { name: 'Iniciar importação' }).click();

    const jobs = page.getByRole('region', { name: 'Jobs em andamento' });
    // `exact` — the card renders the conta's nome as its own text; the
    // region's Histórico link merely CONTAINS it.
    await expect(jobs.getByText(row(1), { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(jobs.getByText('Importação concluída.')).toBeVisible({ timeout: 20_000 });
    await expect(jobs.getByText(/40 encontrados · 12 importados \(5 novos\)/)).toBeVisible();

    const inicios = stubs.chamadas.filter((c) => c.rota === 'importar-todos');
    expect(inicios).toHaveLength(1);
    expect(inicios[0]!.metodo).toBe('POST');
    expect(inicios[0]!.corpo).toMatchObject({
      integracaoId: row(1),
      options: { statuses: ['NORMAL', 'UNLIST'], updateTimeFromS: null, updateTimeToS: null },
    });
    // Every poll asked for the job the start returned — and none after the end.
    const consultados = jobsConsultados(stubs);
    expect(consultados.length).toBeGreaterThanOrEqual(2);
    expect(new Set(consultados)).toEqual(new Set([JOB_NOVO]));
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('a busy start attaches the card to the running job, and a reload brings it back', async ({
    page,
  }) => {
    const stubs = await instalarStubs(page, 'em-andamento');
    await iniciarImportacao(page, prefix, row(1));

    const jobs = page.getByRole('region', { name: 'Jobs em andamento' });
    await expect(jobs.getByText(/o painel passou a acompanhá-la/)).toBeVisible({
      timeout: 15_000,
    });
    // A card that can be followed — never the failed-start alert.
    await expect(jobs.getByText(/30 na fila/)).toBeVisible({ timeout: 15_000 });
    await expect(jobs.getByText(MSG_IMPORTACAO_EM_ANDAMENTO)).toHaveCount(0);
    await expect
      .poll(() => jobsConsultados(stubs), { timeout: 15_000 })
      .toContain(JOB_EM_ANDAMENTO);
    expect(new Set(jobsConsultados(stubs))).toEqual(new Set([JOB_EM_ANDAMENTO]));

    // The reload path: no selection, no click — the card is remembered by the tab.
    const antes = jobsConsultados(stubs).length;
    await page.reload();
    await expect(jobs.getByText(row(1), { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(jobs.getByText(/30 na fila/)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => jobsConsultados(stubs).length, { timeout: 15_000 })
      .toBeGreaterThan(antes);
    expect(new Set(jobsConsultados(stubs))).toEqual(new Set([JOB_EM_ANDAMENTO]));
    // The start itself was never repeated: the reload only polls.
    expect(stubs.chamadas.filter((c) => c.rota === 'importar-todos')).toHaveLength(1);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });
});
