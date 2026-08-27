import { expect, test, type Page } from '@playwright/test';
import {
  cleanupPedidoFreteFixtures,
  e2ePrefix,
  seedPedidoFreteFixtures,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowVisible } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the carrier-less generic-label etiqueta row action
 * on `/pedidos` (motoboy / outros — no carrier API, `FREIGHT_TIPO_CAPS`
 * `labelMode: 'generic'`). The dispatch/provider logic is unit-tested
 * (`etiquetaActions.test.ts`, `providers/genericLabel.test.ts`); this proves
 * the whole path against the real UI + Firestore: the FreteCell HoverCard
 * offers both label formats for a motoboy pedido with no bought label, and
 * clicking either one renders it in the browser and hands the bytes to the
 * local print agent.
 *
 * Network is stubbed (below): only the local print agent — the generic label
 * is built client-side from Firestore data, no marketplace/carrier route is
 * involved — so a 200 means `printJob` reports 'printed', never the download
 * fallback.
 */

interface RouteStubs {
  /** every local-print-agent POST body, in call order. */
  printJobs: Array<Record<string, unknown>>;
}

/**
 * Register the print-agent stub. MUST run BEFORE `page.goto`: an unstubbed
 * (or non-200) print-agent route makes `printJob` fall back to a browser
 * download, with no POST to observe.
 */
async function installRouteStubs(page: Page): Promise<RouteStubs> {
  const stubs: RouteStubs = { printJobs: [] };

  await page.route('http://localhost:8888/**', async (route) => {
    const body = route.request().postData() ?? '{}';
    try {
      stubs.printJobs.push(JSON.parse(body) as Record<string, unknown>);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    await route.fulfill({ status: 200, body: 'ok' });
  });

  return stubs;
}

test.describe.serial('Pedidos — etiqueta genérica (row action)', () => {
  const prefix = e2ePrefix('egn');
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

  /**
   * Open the seeded motoboy pedido's etiqueta HoverCard and click one of its two
   * format buttons. ⚠️ Both are matched EXACTLY: Playwright's `name` is a
   * substring match, so a bare `'Imprimir etiqueta'` would resolve to two
   * elements and fail strict mode.
   *
   * ⚠️ The hover is retried rather than waited on — see the note at the call.
   */
  async function clickEtiqueta(page: Page, label: string): Promise<void> {
    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

    // Narrow to the seeded motoboy pedido (frete estado 'iniciado', no
    // printLabelId) — the prefix keeps concurrent writers out.
    await applyTextFilter(page, 'Número', fixtures.motPedidoId);
    await expectRowVisible(page, fixtures.motPedidoId);

    const row = page.getByRole('row', { name: new RegExp(fixtures.motPedidoId) });
    const button = page.getByRole('button', { name: label, exact: true });

    // ⚠️ RE-HOVER on every attempt — never one hover plus a longer wait.
    // The HoverCard carries `openDelay={150}` (`PedidoCells.tsx:147`) and
    // `/pedidos` is a LIVE TableView, so a snapshot landing inside that 150ms
    // window re-renders the row, drops the hover, and the card never opens. A
    // single `.hover()` then burns its whole timeout AND all three Playwright
    // retries — the run reports a hard failure, not a flake.
    //
    // Waiting longer cannot fix it: the hover is already lost. Only re-issuing
    // it can. Observed failing 3/3 on branches carrying ZERO code changes, so
    // this is the spec racing the UI, not the UI being wrong.
    await expect(async () => {
      await row.getByText('Iniciado', { exact: true }).hover();
      await expect(button).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });

    // Not yet posted — no risk confirm, prints straight away.
    await button.click();
  }

  test('prints the generic label as ZPL for a motoboy pedido', async ({ page }) => {
    const stubs = await installRouteStubs(page);
    await clickEtiqueta(page, 'Imprimir etiqueta (ZPL2)');

    // Exactly one print-agent POST, routed as an etiqueta-size job — the
    // stub 200 pins the print path (never the download fallback).
    await expect.poll(() => stubs.printJobs.length, { timeout: 30_000 }).toBe(1);
    const job = stubs.printJobs[0]!;
    expect(job.tamanhoFolhaImpressao).toBe('etq');
    // The agent routes on contentType: plain text is its RAW-spooler channel,
    // the one the Zebra reads.
    expect(job.contentType).toBe('text/plain;charset=utf-8');
    expect(job.docName).toBe(`etiqueta-${fixtures.motPedidoId}.zpl2`);
    // Real ZPL, not an empty blob — decoding pins the whole render, not just
    // that a POST happened.
    const zpl = Buffer.from(String(job.docDataBase64), 'base64').toString('utf8');
    expect(zpl.startsWith('^XA')).toBe(true);
    expect(zpl).toContain('^CI28');
    expect(zpl.trimEnd().endsWith('^XZ')).toBe(true);
  });

  test('prints the generic label as PDF from the same HoverCard', async ({ page }) => {
    const stubs = await installRouteStubs(page);
    await clickEtiqueta(page, 'Imprimir etiqueta (PDF)');

    await expect.poll(() => stubs.printJobs.length, { timeout: 30_000 }).toBe(1);
    const job = stubs.printJobs[0]!;
    expect(job.tamanhoFolhaImpressao).toBe('etq');
    expect(job.contentType).toBe('application/pdf');
    expect(job.docName).toBe(`etiqueta-${fixtures.motPedidoId}.pdf`);
    // A real PDF: `%PDF-` is `JVBERi0` once base64-encoded.
    expect(String(job.docDataBase64)).toMatch(/^JVBERi0/);
  });
});
