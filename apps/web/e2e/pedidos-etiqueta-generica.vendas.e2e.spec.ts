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
 * offers "Imprimir etiqueta" for a motoboy pedido with no bought label, and
 * clicking it renders the generic PDF and hands it to the local print agent.
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

  test('renders and prints the generic PDF for a motoboy pedido', async ({ page }) => {
    const stubs = await installRouteStubs(page);

    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

    // Narrow to the seeded motoboy pedido (frete estado 'iniciado', no
    // printLabelId) — the prefix keeps concurrent writers out.
    await applyTextFilter(page, 'Número', fixtures.motPedidoId);
    await expectRowVisible(page, fixtures.motPedidoId);

    const row = page.getByRole('row', { name: new RegExp(fixtures.motPedidoId) });
    await row.getByText('Iniciado', { exact: true }).hover();
    const imprimir = page.getByRole('button', { name: 'Imprimir etiqueta' });
    await expect(imprimir).toBeVisible({ timeout: 15_000 });

    // Not yet posted — no risk confirm, prints straight away.
    await imprimir.click();

    // Exactly one print-agent POST, routed as an etiqueta-size job — the
    // stub 200 pins the print path (never the download fallback).
    await expect.poll(() => stubs.printJobs.length, { timeout: 30_000 }).toBe(1);
    expect(stubs.printJobs[0]!.tamanhoFolhaImpressao).toBe('etq');
  });
});
