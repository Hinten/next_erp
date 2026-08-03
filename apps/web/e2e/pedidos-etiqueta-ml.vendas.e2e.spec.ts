import { expect, test, type Page } from '@playwright/test';
import {
  cleanupPedidoFreteFixtures,
  e2ePrefix,
  seedPedidoFreteFixtures,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowVisible } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the Mercado Livre etiqueta row action on `/pedidos`
 * (the shipment-label fetch flow). The dispatch/provider logic is unit-tested
 * (`etiquetaActions.test.ts`, `providers/mercadoLivre.test.ts`); this proves the
 * whole path against the real UI + Firestore: the FreteCell HoverCard offers the
 * two legacy print entries for an ML-managed frete, the already-posted risk
 * confirm gates the fetch, and accepting it fetches the label from the
 * marketplace route and hands it to the local print agent.
 *
 * Network is stubbed (below): the etiqueta proxy route (so no real ML account is
 * needed) and the local print agent (so the print path is deterministic — a 200
 * means `printJob` reports 'printed', never the download fallback).
 */

interface RouteStubs {
  /** every `/api/marketplace/mercado-livre/etiqueta` request URL, in call order. */
  etiquetaRequests: string[];
  /** every local-print-agent POST body, in call order. */
  printJobs: Array<Record<string, unknown>>;
}

// A minimal valid (empty) ZIP: the EOCD record alone — 'PK\x05\x06' + 18 zero
// bytes. Enough for the byte-sniffed content-type and for any consumer that
// forwards the bytes verbatim.
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);

/**
 * Register the network stubs the fetch-label path hits. MUST run BEFORE
 * `page.goto`: an unhandled print-agent route (or a non-200) makes `printJob`
 * fall back to a browser download with no POST to observe, and an unstubbed
 * etiqueta call would need a live ML account on staging.
 */
async function installRouteStubs(page: Page): Promise<RouteStubs> {
  const stubs: RouteStubs = { etiquetaRequests: [], printJobs: [] };

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

  // The mercado-livre etiqueta proxy — return ZIP-ish label bytes.
  await page.route('**/api/marketplace/mercado-livre/etiqueta**', async (route) => {
    stubs.etiquetaRequests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/zip',
      headers: {
        'Content-Disposition': 'attachment; filename="etiqueta-stub.zip"',
        'Cache-Control': 'no-store',
      },
      body: ZIP_BYTES,
    });
  });

  return stubs;
}

test.describe.serial('Pedidos — etiqueta Mercado Livre (row action)', () => {
  const prefix = e2ePrefix('eml');
  let fixtures: Awaited<ReturnType<typeof seedPedidoFreteFixtures>>;

  test.beforeAll(async ({ browser }) => {
    // First-load route compilation can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    fixtures = await seedPedidoFreteFixtures(prefix);
    await warmRoutes(browser, ['/pedidos']);
  });

  test.afterAll(async () => {
    await cleanupPedidoFreteFixtures(prefix);
  });

  test('fetches and prints the ML label after the posted-risk confirm', async ({ page }) => {
    const stubs = await installRouteStubs(page);

    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

    // Narrow to the seeded marketplace pedido (frete estado 'postado',
    // externalId 'ML-0001') — the prefix keeps concurrent writers out.
    await applyTextFilter(page, 'Número', fixtures.mktPedidoId);
    await expectRowVisible(page, fixtures.mktPedidoId);

    // The FreteCell HoverCard on the row's 'Postado' badge offers the two
    // legacy entries (ZPL2 primary + PDF sub-action).
    const row = page.getByRole('row', { name: new RegExp(fixtures.mktPedidoId) });
    await row.getByText('Postado', { exact: true }).hover();
    const zpl2 = page.getByRole('button', { name: 'Imprimir Etiqueta Transporte (ZPL2)' });
    await expect(zpl2).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('button', { name: 'Imprimir Etiqueta Transporte (PDF)' }),
    ).toBeVisible();

    // A 'postado' frete → the risk confirm gates the fetch.
    await zpl2.click();
    const continuar = page.getByRole('button', { name: 'Continuar' });
    await expect(page.getByText(/já foi postado/)).toBeVisible({ timeout: 15_000 });
    // Accept via keyboard: a mouse move onto the modal would close the
    // HoverCard (and unmount the action) before the confirm resolves.
    await continuar.press('Enter');

    // Exactly one label fetch, for THIS pedido in the requested format...
    await expect.poll(() => stubs.etiquetaRequests.length, { timeout: 30_000 }).toBe(1);
    expect(stubs.etiquetaRequests[0]).toContain(`pedidoId=${fixtures.mktPedidoId}`);
    expect(stubs.etiquetaRequests[0]).toContain('formato=zpl2');

    // ...and exactly one print-agent POST (the stub 200 pins the print path —
    // never the download fallback), routed as an etiqueta-size job.
    await expect.poll(() => stubs.printJobs.length, { timeout: 30_000 }).toBe(1);
    expect(stubs.printJobs[0]!.tamanhoFolhaImpressao).toBe('etq');
  });
});
