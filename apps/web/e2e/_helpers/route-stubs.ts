import type { Page } from '@playwright/test';
import type { RespostaConferenciaPagamentoLi } from '@delfrance/schemas';

/**
 * Network stubs several staging e2e specs share. Every one MUST be installed
 * BEFORE `page.goto`: a route registered after the page asked is never seen.
 */

export interface RouteStubs {
  /** every `/api/freight/melhor-envio/imprimir` payload, in call order. */
  freightImprimir: Array<{ intFreteId: string; printLabelId: string }>;
  /** every local-print-agent POST body, in call order. */
  printJobs: Array<Record<string, unknown>>;
}

/**
 * The stubs the checkout's save/reprint paths and the `/pedidos` label actions
 * hit: the local print agent, the Melhor Envio `/imprimir` route and every
 * `/api/nfe/**` call.
 *
 * - The print agent answers 200, so `printJob` reports 'printed': an unhandled
 *   (or non-200) agent route makes it fall back to a browser download, with no
 *   POST to observe.
 * - The Melhor Envio print route answers a label URL and records its payload.
 * - NF-e answers 503 so nothing reaches staging SEFAZ: the post-save flow
 *   narrows that to a typed NF-e error and toasts it, after the checkout is
 *   already committed, so it can never fail a save.
 */
export async function installRouteStubs(page: Page): Promise<RouteStubs> {
  const stubs: RouteStubs = { freightImprimir: [], printJobs: [] };

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

  // Melhor Envio label print — capture `{ intFreteId, printLabelId }` and return
  // a label URL.
  await page.route('**/api/freight/melhor-envio/imprimir', async (route) => {
    stubs.freightImprimir.push(
      route.request().postDataJSON() as { intFreteId: string; printLabelId: string },
    );
    await route.fulfill({ json: { url: 'https://example.invalid/label.pdf' } });
  });

  await page.route('**/api/nfe/**', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'nfe stubbed in e2e' }),
    });
  });

  return stubs;
}

/** The Loja Integrada paid re-check route, on whatever backend host the build points at. */
const CONFERENCIA_PAGAMENTO_LI = '**/api/marketplace/loja-integrada/pedidos/*/pagamento';

export interface StubConferenciaPagamentoLi {
  /** The pedido id of every call, in order — the path segment, decoded. */
  readonly chamadas: string[];
}

/**
 * A non-2xx answer of the paid re-check route: the backend's error envelope
 * (`{ error, code }`, a `CODIGO_ERRO_LI` code) at `status`.
 */
export interface ErroConferenciaPagamentoLi {
  readonly status: number;
  readonly envelope: { readonly error: string; readonly code: string };
}

/**
 * Stub `GET …/pedidos/[pedidoId]/pagamento` on the `apps/loja-integrada`
 * backend (master plan step 15) with a fixed answer — a 200 verdict, or an
 * error envelope ({@link ErroConferenciaPagamentoLi}) — recording every call.
 *
 * The e2e build has no Loja Integrada backend at all, and the route is covered
 * by its own offline suites — so every spec that reaches a paid re-check stubs
 * it, the way the conta screen's spec stubs the Melhor Envio service list.
 * Playwright answers the CORS preflight of this cross-origin GET itself, and
 * adds the allow-origin header to the answer fulfilled here.
 */
export async function stubConferenciaPagamentoLi(
  page: Page,
  resposta: RespostaConferenciaPagamentoLi | ErroConferenciaPagamentoLi,
): Promise<StubConferenciaPagamentoLi> {
  const stub: StubConferenciaPagamentoLi = { chamadas: [] };
  const [status, corpo] =
    'envelope' in resposta ? [resposta.status, resposta.envelope] : [200, resposta];
  await page.route(CONFERENCIA_PAGAMENTO_LI, async (route) => {
    const segmentos = new URL(route.request().url()).pathname.split('/');
    stub.chamadas.push(decodeURIComponent(segmentos[segmentos.length - 2] ?? ''));
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify(corpo),
    });
  });
  return stub;
}
