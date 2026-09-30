import { expect, test, type Page } from '@playwright/test';
import {
  cleanupPedidoEtiquetaShopeeFixtures,
  e2ePrefix,
  seedPedidoEtiquetaShopeeFixtures,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowVisible } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the Shopee etiqueta row action on `/pedidos` (#1523,
 * step 15). The loop, the gates and the dialog are unit-tested
 * (`providers/shopee.test.ts`, `registry.test.ts`, `EscolherEnvioDialog.test.tsx`,
 * `EtiquetaAcaoHost.test.tsx`); this proves the four things only the real UI in
 * a real browser shows:
 *
 *   - REACHABILITY — the seeded pedido has no `int_frete` document at all, and
 *     its FreteCell HoverCard still offers both fetch entries off the frete
 *     block alone;
 *   - NO posted-risk confirm — the frete sits at `error`, an estado the shared
 *     gates treat as already posted, and a Shopee reprint is the same document
 *     (`reimpressao: 'mesmo-documento'`), so the flow goes straight to the route;
 *   - the pickup question SURVIVES the HoverCard — the dialog lives in the page
 *     host (`EtiquetaAcaoHost`), so it stays open, and is answered by MOUSE,
 *     after moving off the HoverCard has unmounted the row action;
 *   - the answer rides exactly ONE call, and the label reaches the print agent.
 *
 * Network is stubbed (below): the Shopee label route — a scripted question →
 * wait → file, so no Shopee conta is needed — and the local print agent, so a
 * 200 pins the print path (never the download fallback).
 */

interface RouteStubs {
  /** every Shopee label request BODY, parsed, in call order. */
  etiquetaBodies: Array<Record<string, unknown>>;
  /** every local-print-agent POST body, in call order. */
  printJobs: Array<Record<string, unknown>>;
}

/** The scripted order's one package (fixture id). */
const PACOTE = 'OFG000000000001';

/**
 * Call 1's answer: how does the package ship? The shape is the backend's
 * `escolher-envio` 202 (`apps/shopee/lib/shopee/etiqueta/pendenteEtiqueta.ts`),
 * with fixture ids. ⚠️ TWO slots, and the answer below picks the one that is
 * NOT pre-selected: a request carrying `slot-2` can only come from the mouse
 * click, never from the dialog's own default.
 */
const PERGUNTA = {
  acao: 'escolher-envio',
  fase: 'programando',
  pacote: PACOTE,
  pacoteRotulo: null,
  mensagem:
    'Escolha como enviar o pacote: o endereço e o horário da coleta, ou a postagem na agência.',
  enderecos: [
    {
      id: '2001',
      rotulo: 'Rua do Vendedor, 100',
      principal: true,
      horarios: [
        { id: 'slot-1', rotulo: '09:00', recomendado: true },
        { id: 'slot-2', rotulo: '14:00', recomendado: false },
      ],
    },
  ],
  permiteDropoff: true,
  escolhaInvalida: false,
  progresso: { total: 1, organizados: 0, comRastreio: 0, prontos: 0 },
};

/** Call 2's answer — the package shipped, the document is being generated. */
const ESPERA = {
  acao: 'aguardar',
  fase: 'gerando-documento',
  // The provider's floor: the shortest wait it will honour.
  tentarEmMs: 2_000,
  mensagem: 'Envio organizado; a Shopee está gerando a etiqueta.',
  progresso: { total: 1, organizados: 1, comRastreio: 1, prontos: 0 },
};

/** Call 3's answer: enough of a PDF for the agent's `%PDF-` check. */
const PDF_BYTES = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');

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
 * label call would need a live Shopee conta.
 *
 * The label route answers BY CALL INDEX, and the assertions check what each
 * call carried — so a loop that re-sent the answer, or skipped it, shows up as
 * a wrong body rather than as a stub that quietly adapted.
 */
async function installRouteStubs(page: Page, numero: string): Promise<RouteStubs> {
  const stubs: RouteStubs = { etiquetaBodies: [], printJobs: [] };

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

  // The Shopee label route (a cross-origin POST). Playwright answers the CORS
  // preflight itself before any handler runs, so only the POSTs land here, and
  // it adds the allow-origin header to every answer fulfilled below.
  await page.route('**/api/marketplace/shopee/etiqueta', async (route) => {
    stubs.etiquetaBodies.push(corpoDaChamada(route.request().postData()));
    const chamada = stubs.etiquetaBodies.length;
    const json = (corpo: unknown) =>
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(corpo),
      });

    if (chamada === 1) return json(PERGUNTA);
    if (chamada === 2) return json(ESPERA);
    if (chamada === 3) {
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        headers: {
          'Content-Disposition': `attachment; filename="etiqueta-shopee-${numero}.pdf"`,
          'Cache-Control': 'no-store',
          // Without it a cross-origin `fetch` reads `Content-Disposition` as
          // null and the file falls back to a generic name — the backend's
          // proxy exposes it, so the stub does too.
          'Access-Control-Expose-Headers': 'Content-Disposition',
        },
        body: PDF_BYTES,
      });
    }
    // A 4th call is a loop that did not stop at the file: refuse it, so the
    // click ends and the body assertion names the extra call.
    const mensagem = 'Chamada inesperada à rota de etiqueta (stub do e2e).';
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: mensagem,
        code: 'SHOPEE_ETIQUETA_RECUSADA',
        motivo: 'stub',
        mensagem,
      }),
    });
  });

  return stubs;
}

test.describe.serial('Pedidos — etiqueta Shopee (row action)', () => {
  const prefix = e2ePrefix('esh');
  let fixtures: Awaited<ReturnType<typeof seedPedidoEtiquetaShopeeFixtures>>;

  test.beforeAll(async ({ browser }) => {
    // First-load route compilation can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    fixtures = await seedPedidoEtiquetaShopeeFixtures(prefix);
    await warmRoutes(browser, ['/pedidos']);
  });

  test.afterAll(async () => {
    await cleanupPedidoEtiquetaShopeeFixtures(prefix);
  });

  test('answers the pickup question by mouse and prints the label with no posted confirm', async ({
    page,
  }) => {
    const { pedidoId } = fixtures;
    const stubs = await installRouteStubs(page, pedidoId);

    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

    // Narrow to the seeded pedido — the prefix keeps concurrent writers out.
    await applyTextFilter(page, 'Número', pedidoId);
    await expectRowVisible(page, pedidoId);

    const row = page.getByRole('row', { name: new RegExp(pedidoId) });
    const zpl2 = page.getByRole('button', {
      name: 'Imprimir Etiqueta Transporte (ZPL2)',
      exact: true,
    });
    const pdf = page.getByRole('button', {
      name: 'Imprimir Etiqueta Transporte (PDF)',
      exact: true,
    });

    // Reachability: the HoverCard on the frete's 'Erro' badge offers BOTH fetch
    // entries, live. ⚠️ RE-HOVER on every attempt (`/pedidos` is a live
    // TableView: a snapshot landing inside the card's 150ms open delay
    // re-renders the row and drops the hover — see the generic-label spec).
    await expect(async () => {
      await row.getByText('Erro', { exact: true }).hover();
      await expect(pdf).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(zpl2).toBeVisible();
    await expect(zpl2).toBeEnabled();
    await expect(pdf).toBeEnabled();

    await pdf.click();

    // The first thing the click produces is the pickup question — the route
    // was reached with NO posted-risk confirm in between, although the frete's
    // estado is one the shared gates treat as posted.
    const pergunta = page.getByRole('dialog').filter({ hasText: 'Como enviar o pacote' });
    await expect(pergunta).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/já foi postado/)).toHaveCount(0);
    expect(stubs.etiquetaBodies).toHaveLength(1);

    // It SURVIVES the HoverCard: move off the card, wait until it has unmounted
    // the row action (and its buttons), and the question is still open.
    await page.mouse.move(0, 0);
    await expect(pdf).toBeHidden({ timeout: 10_000 });
    await expect(pergunta).toBeVisible();

    // Shopee's own marks are pre-selected: the principal address, the
    // recommended slot.
    await expect(pergunta.getByRole('radio', { name: /Rua do Vendedor, 100/ })).toBeChecked();
    await expect(pergunta.getByRole('radio', { name: /^09:00/ })).toBeChecked();

    // Answered BY MOUSE — the other slot, then Confirmar.
    await pergunta.getByRole('radio', { name: /^14:00/ }).check();
    await pergunta.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(pergunta).toBeHidden();

    // Exactly one print-agent POST — the stub 200 pins the print path.
    await expect.poll(() => stubs.printJobs.length, { timeout: 30_000 }).toBe(1);

    // Exactly three label calls, and the answer rides ONLY the one right after
    // the question — never re-sent on the call that fetched the file.
    expect(stubs.etiquetaBodies).toEqual([
      { pedidoId, formato: 'pdf' },
      {
        pedidoId,
        formato: 'pdf',
        envio: { pacote: PACOTE, modo: 'pickup', enderecoId: '2001', horarioId: 'slot-2' },
      },
      { pedidoId, formato: 'pdf' },
    ]);

    const job = stubs.printJobs[0]!;
    // The agent routes on contentType with `==`: the bare type, never a charset.
    expect(job.contentType).toBe('application/pdf');
    // A Shopee PDF goes to the A4 printer (`TAMANHO_DO_PDF_SHOPEE`, legacy
    // parity) — this assertion moves with that constant.
    expect(job.tamanhoFolhaImpressao).toBe('a4');
    // The route's own filename, read through the exposed header.
    expect(job.docName).toBe(`etiqueta-shopee-${pedidoId}.pdf`);
    // The bytes the route sent: `%PDF-` is `JVBERi0` once base64-encoded.
    expect(String(job.docDataBase64)).toMatch(/^JVBERi0/);
  });
});
