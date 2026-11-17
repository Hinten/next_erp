import { expect, test, type Page } from '@playwright/test';
import {
  CODIGO_ERRO_ETIQUETA_AMAZON,
  ESTADO_FRETE,
  ESTADO_FRETE_LABELS,
  MOTIVO_ETIQUETA_AMAZON,
} from '@delfrance/schemas';
import { MENSAGENS_MOTIVO_ETIQUETA_AMAZON } from '../lib/amazon/erros';
import {
  cleanupPedidoEtiquetaAmazonFixtures,
  e2ePrefix,
  seedPedidoEtiquetaAmazonFixtures,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowVisible } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the Amazon etiqueta row action on `/pedidos` (step
 * 15). The provider, the client and the copy are unit-tested
 * (`providers/amazon.test.ts`, `lib/amazon/client.test.ts`,
 * `lib/amazon/erros.test.ts`, `registry.test.ts`); this proves what only the
 * real UI in a real browser shows:
 *
 *   - REACHABILITY — the seeded pedidos have no `int_frete` document at all,
 *     and the FreteCell HoverCard still offers both fetch entries off the
 *     frete block alone;
 *   - NO posted-risk confirm — the scheduled pedido sits at
 *     `aguardandoPostagem`, an estado the shared gates treat as already
 *     posted, and an Amazon reprint is the same document
 *     (`reimpressao: 'mesmo-documento'`);
 *   - the label reaches the print agent as ZPL: `contentType` EXACTLY
 *     `text/plain` although the answer carried a charset, the thermal size,
 *     the route's own file name, and the route's bytes untouched (one of them
 *     is not valid UTF-8, so a decode and re-encode would change it);
 *   - a 409 `AGUARDANDO_NFE` shows its motivo's copy and sends nothing to the
 *     print agent.
 *
 * Network is stubbed (below): the `apps/amazon` label route — matched on its
 * PATHNAME, whatever host the build points the client at — and the local print
 * agent, so a 200 pins the print path (never the download fallback). ⚠️ No case
 * may ever reach Amazon: every request to an Amazon or AWS host is aborted and
 * recorded, and the record is asserted EMPTY after each case.
 */

/** The label route's path (`apps/amazon`), under the backend's CORS matcher. */
const ETIQUETA_PATH = '/api/marketplace/amazon/etiqueta';

/** A fixture order id in Amazon's 3-7-7 shape — the route names the file after it. */
const ORDER_ID = '000-0000000-0000001';

/**
 * The label the stubbed route answers: a minimal ZPL with ONE byte that is
 * not valid UTF-8 (`0xC9`), so only an untouched byte path delivers it as sent.
 */
const ZPL_BYTES = Buffer.concat([
  Buffer.from('^XA^FO40,40^A0N,30,30^FDETIQUETA E2E ', 'latin1'),
  Buffer.from([0xc9]),
  Buffer.from('^FS^XZ\n', 'latin1'),
]);

interface RouteStubs {
  /** every label request BODY, parsed, in call order. */
  etiquetaBodies: Array<Record<string, unknown>>;
  /** every local-print-agent POST body, in call order. */
  printJobs: Array<Record<string, unknown>>;
  /** every request that tried to reach an Amazon or AWS host (each one aborted). */
  amazon: string[];
}

type RespostaEtiqueta =
  | { readonly tipo: 'zpl' }
  | { readonly tipo: 'erro'; readonly status: number; readonly corpo: unknown };

/** Is this URL on an Amazon or AWS host (any subdomain)? */
function ehHostAmazon(url: string): boolean {
  return /(^|\.)(amazon\.com(\.br)?|amazonaws\.com)$/i.test(new URL(url).hostname);
}

/** A label request body, parsed — or a marker the body assertion will print. */
function corpoDaChamada(corpo: string | null): Record<string, unknown> {
  try {
    return JSON.parse(corpo ?? '{}') as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) return { corpoNaoJson: corpo };
    throw err;
  }
}

/**
 * Register the network stubs the fetch-label path hits. MUST run BEFORE
 * `page.goto`: an unhandled print-agent route (or a non-200) makes `printJob`
 * fall back to a browser download with no POST to observe, and an unstubbed
 * label call would need a running `apps/amazon`.
 *
 * The label route answers the FIRST call with `resposta`; a second call is
 * refused (409), so a provider that retried shows up in the body assertion
 * rather than as a stub that quietly answered twice.
 */
async function installRouteStubs(page: Page, resposta: RespostaEtiqueta): Promise<RouteStubs> {
  const stubs: RouteStubs = { etiquetaBodies: [], printJobs: [], amazon: [] };

  // The belt: no case may reach Amazon or AWS, from the page or from anything
  // it loads. An aborted request still fires `request`, so it is recorded.
  page.on('request', (req) => {
    if (ehHostAmazon(req.url())) stubs.amazon.push(req.url());
  });
  await page.route(
    (url) => ehHostAmazon(url.href),
    (route) => route.abort(),
  );

  // Local print agent — collect the body, then 200 so `printJob` reports success.
  await page.route('http://localhost:8888/**', async (route) => {
    const body = route.request().postData() ?? '{}';
    try {
      stubs.printJobs.push(JSON.parse(body) as Record<string, unknown>);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    await route.fulfill({ status: 200, body: 'ok' });
  });

  // The label route (a cross-origin POST). Playwright answers the CORS
  // preflight itself before any handler runs, so only the POSTs land here, and
  // it adds the allow-origin header to every answer fulfilled below.
  await page.route(
    (url) => url.pathname === ETIQUETA_PATH,
    async (route) => {
      stubs.etiquetaBodies.push(corpoDaChamada(route.request().postData()));
      if (stubs.etiquetaBodies.length > 1) {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Chamada inesperada à rota de etiqueta (stub do e2e).',
            code: 'E2E_INESPERADA',
          }),
        });
      }
      if (resposta.tipo === 'erro') {
        return route.fulfill({
          status: resposta.status,
          contentType: 'application/json',
          headers: { 'Cache-Control': 'no-store' },
          body: JSON.stringify(resposta.corpo),
        });
      }
      return route.fulfill({
        status: 200,
        headers: {
          // A parameter a proxy may append: the agent must still get the bare type.
          'Content-Type': 'text/plain; charset=UTF-8',
          'Content-Disposition': `attachment; filename="amazon-${ORDER_ID}.zpl"`,
          'Cache-Control': 'no-store',
          // Without it a cross-origin `fetch` reads `Content-Disposition` as
          // null and the file falls back to a generic name — the backend's
          // proxy exposes it, so the stub does too.
          'Access-Control-Expose-Headers': 'Content-Disposition',
        },
        body: ZPL_BYTES,
      });
    },
  );

  return stubs;
}

/** Narrow `/pedidos` to one seeded pedido and open its frete HoverCard on `badge`. */
async function abrirAcoesDoFrete(page: Page, pedidoId: string, badge: string): Promise<void> {
  await page.goto('/pedidos');
  await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

  // Narrow to the seeded pedido — the prefix keeps concurrent writers out.
  await applyTextFilter(page, 'Número', pedidoId);
  await expectRowVisible(page, pedidoId);

  const row = page.getByRole('row', { name: new RegExp(pedidoId) });
  const pdf = page.getByRole('button', { name: 'Imprimir Etiqueta Transporte (PDF)', exact: true });
  // ⚠️ RE-HOVER on every attempt (`/pedidos` is a live TableView: a snapshot
  // landing inside the card's 150ms open delay re-renders the row and drops
  // the hover — see the generic-label spec).
  await expect(async () => {
    await row.getByText(badge, { exact: true }).hover();
    await expect(pdf).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

test.describe.serial('Pedidos — etiqueta Amazon (row action)', () => {
  const prefix = e2ePrefix('eamz');
  let fixtures: Awaited<ReturnType<typeof seedPedidoEtiquetaAmazonFixtures>>;
  let stubs: RouteStubs | null = null;

  test.beforeAll(async ({ browser }) => {
    // First-load route compilation can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    fixtures = await seedPedidoEtiquetaAmazonFixtures(prefix);
    await warmRoutes(browser, ['/pedidos']);
  });

  test.afterEach(() => {
    expect(stubs?.amazon ?? []).toEqual([]);
    stubs = null;
  });

  test.afterAll(async () => {
    await cleanupPedidoEtiquetaAmazonFixtures(prefix);
  });

  test('prints the ZPL label as text/plain on the thermal size, with no posted confirm', async ({
    page,
  }) => {
    const pedidoId = fixtures.agendado;
    const s = await installRouteStubs(page, { tipo: 'zpl' });
    stubs = s;

    await abrirAcoesDoFrete(page, pedidoId, ESTADO_FRETE_LABELS[ESTADO_FRETE.aguardandoPostagem]);
    const zpl2 = page.getByRole('button', {
      name: 'Imprimir Etiqueta Transporte (ZPL2)',
      exact: true,
    });
    await expect(zpl2).toBeEnabled();
    await zpl2.click();

    // Exactly one print-agent POST — the stub 200 pins the print path.
    await expect.poll(() => s.printJobs.length, { timeout: 30_000 }).toBe(1);
    // The route was reached with NO posted-risk confirm in between, although
    // the frete's estado is one the shared gates treat as posted.
    await expect(page.getByText(/já foi postado/)).toHaveCount(0);

    // ONE label call, carrying exactly the pedido id.
    expect(s.etiquetaBodies).toEqual([{ pedidoId }]);

    const job = s.printJobs[0]!;
    // The agent routes on contentType with `==`: the bare type, never the
    // charset the answer carried.
    expect(job.contentType).toBe('text/plain');
    // A ZPL label goes to the thermal printer at label size.
    expect(job.tamanhoFolhaImpressao).toBe('etq');
    // The route's own filename, read through the exposed header.
    expect(job.docName).toBe(`amazon-${ORDER_ID}.zpl`);
    // The route's bytes, untouched — the 0xC9 byte included.
    expect(job.docDataBase64).toBe(ZPL_BYTES.toString('base64'));
  });

  test('a 409 AGUARDANDO_NFE shows the wait-and-reprint copy and sends nothing to the agent', async ({
    page,
  }) => {
    const pedidoId = fixtures.aguardandoNfe;
    const copia = MENSAGENS_MOTIVO_ETIQUETA_AMAZON[MOTIVO_ETIQUETA_AMAZON.nfeEmProcessamento];
    // The only NF-e motivo that asks for a wait and a reprint.
    expect(copia).toMatch(/Aguarde e reimprima pela lista de pedidos/);
    const s = await installRouteStubs(page, {
      tipo: 'erro',
      status: 409,
      corpo: {
        error: 'A Amazon ainda não aceitou a NF-e deste pedido.',
        code: CODIGO_ERRO_ETIQUETA_AMAZON.AGUARDANDO_NFE,
        motivo: MOTIVO_ETIQUETA_AMAZON.nfeEmProcessamento,
      },
    });
    stubs = s;

    // The block's estado while Amazon has not accepted the NF-e.
    await abrirAcoesDoFrete(page, pedidoId, ESTADO_FRETE_LABELS[ESTADO_FRETE.aguardandoNFe]);
    const zpl2 = page.getByRole('button', {
      name: 'Imprimir Etiqueta Transporte (ZPL2)',
      exact: true,
    });
    await expect(zpl2).toBeEnabled();
    await zpl2.click();

    // The motivo's sentence, never the route's own `error` text.
    await expect(page.getByRole('alert').filter({ hasText: copia }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('A Amazon ainda não aceitou a NF-e deste pedido.')).toHaveCount(0);

    expect(s.etiquetaBodies).toEqual([{ pedidoId }]);
    // Nothing reached the print agent.
    expect(s.printJobs).toEqual([]);
  });
});
