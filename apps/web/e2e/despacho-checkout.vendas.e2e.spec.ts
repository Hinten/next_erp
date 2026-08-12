import { expect, test, type Page } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import { cleanupCheckoutFixtures, e2ePrefix, seedCheckoutFixtures } from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the despacho/checkout screen (the checkout-screen-port
 * PR 8). The screen is already covered by unit + RTL tests (the reducer, scan
 * engine, save gates, reprint helpers); this suite proves the whole thing works
 * against the real UI + Firestore + the post-save/reprint network seams:
 *
 *   1. happy path      — scan a 1-line pedido, save, read back the checkout doc.
 *   1b. pedido editor  — the pedido edit page's read-only Checkout tab (#368)
 *       Checkout tab       shows the same doc the happy-path save just wrote.
 *   2. kit             — a whole-kit scan completes the kit line.
 *   3. wrong product   — scanning an unexpected produto logs "Produto não esperado".
 *   4. wrong-label     — THE point of this PR: reprinting a PAST checkout's label
 *      REGRESSION         targets THAT row's pedido, not the most-recent one.
 *   5. 120-item bulk   — a 120-line pedido loads/scans/saves through the real path.
 *
 * Network is stubbed (below): the local print agent, the Melhor Envio `/imprimir`
 * route, and every `/api/nfe/**` call — so post-save never reaches real SEFAZ
 * (the A1 cert is expired) and a save's success never depends on a printer.
 *
 * These run against STAGING and stay red until the PR-1 checkout rules + indexes
 * are deployed (collection-group `checkout` reads are otherwise default-denied);
 * that is expected — the specs are written to be correct regardless.
 */

const SCAN_PLACEHOLDER = /^Bipe o código/;

interface RouteStubs {
  /** every `/api/freight/melhor-envio/imprimir` payload, in call order. */
  freightImprimir: Array<{ intFreteId: string; printLabelId: string }>;
  /** every local-print-agent POST body, in call order. */
  printJobs: Array<Record<string, unknown>>;
}

/**
 * Register the network stubs the save/reprint paths hit. MUST run BEFORE
 * `page.goto`: an unhandled print-agent route (or a non-200) makes `printJob`
 * fall back to a browser download with no POST to observe, and an unstubbed NF-e
 * call would reach staging SEFAZ.
 */
async function installRouteStubs(page: Page): Promise<RouteStubs> {
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
  // a label URL. This is the payload the wrong-label regression asserts on.
  await page.route('**/api/freight/melhor-envio/imprimir', async (route) => {
    stubs.freightImprimir.push(
      route.request().postDataJSON() as { intFreteId: string; printLabelId: string },
    );
    await route.fulfill({ json: { url: 'https://example.invalid/label.pdf' } });
  });

  // NF-e — never reach staging SEFAZ. A non-2xx makes `ensureNfeAprovada` narrow
  // to a typed NF-e error the post-save flow handles with a toast; the checkout
  // is already committed by then, so this can't fail a save.
  await page.route('**/api/nfe/**', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'nfe stubbed in e2e' }),
    });
  });

  return stubs;
}

/** Deep-link to a pedido and wait for it to load (header link is unique per número). */
async function loadPedido(page: Page, numero: string): Promise<void> {
  await page.goto(`/despacho/checkout?pedido=${encodeURIComponent(numero)}`);
  await expect(page.getByRole('link', { name: new RegExp(`Pedido Nº ${numero}\\b`) })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByPlaceholder(SCAN_PLACEHOLDER)).toBeVisible({ timeout: 30_000 });
}

/** Type one code into the scan field and submit it (Enter-only, one unit per Enter). */
async function scan(page: Page, code: string): Promise<void> {
  const input = page.getByPlaceholder(SCAN_PLACEHOLDER);
  await input.fill(code);
  await input.press('Enter');
}

/** The first `checkout` subdoc of a pedido, or null. */
async function readCheckout(pedidoId: string): Promise<Record<string, unknown> | null> {
  const snap = await db().collection('pedidos').doc(pedidoId).collection('checkout').get();
  return snap.docs[0]?.data() ?? null;
}

/** The pedido's live `freteInicial.estado`, or null. */
async function readFreteEstado(pedidoId: string): Promise<string | null> {
  const snap = await db().collection('pedidos').doc(pedidoId).get();
  const frete = (snap.data()?.freteInicial ?? null) as { estado?: string } | null;
  return frete?.estado ?? null;
}

test.describe.serial('Despacho — checkout (e2e)', () => {
  const prefix = e2ePrefix('chk');
  let fx: Awaited<ReturnType<typeof seedCheckoutFixtures>>;

  test.beforeAll(async ({ browser }) => {
    // First-load route compilation can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    fx = await seedCheckoutFixtures(prefix);
    await warmRoutes(browser, ['/despacho/checkout']);
  });

  test.afterAll(async () => {
    await cleanupCheckoutFixtures(prefix, fx.checkoutPedidoIds);
  });

  test('happy path: scan a line, save, and the checkout doc + frete estado land', async ({
    page,
  }) => {
    await installRouteStubs(page);
    await loadPedido(page, fx.happyNumero);

    await expect(page.getByText('Produtos esperados (1)')).toBeVisible({ timeout: 30_000 });

    await scan(page, fx.lineSku);
    await expect(page.getByText('Produtos lançados (1)')).toBeVisible({ timeout: 15_000 });
    // The single line concluded → the expected pane empties.
    await expect(page.getByText('Todos os produtos já foram lançados.')).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Checkout salvo')).toBeVisible({ timeout: 30_000 });

    // Read back: exactly one checkout doc with one itensCheckout entry, and the
    // save transaction flipped the pedido's frete estado to checkFinalizado.
    await expect
      .poll(
        async () => {
          const doc = await readCheckout(fx.happyId);
          const itens = (doc?.itensCheckout ?? []) as unknown[];
          return itens.length;
        },
        { timeout: 20_000 },
      )
      .toBe(1);
    await expect
      .poll(() => readFreteEstado(fx.happyId), { timeout: 20_000 })
      .toBe('checkFinalizado');
  });

  test('pedido editor Checkout tab shows the just-saved checkout (#368)', async ({ page }) => {
    // Depends on the previous test's save — describe.serial guarantees order.
    await page.goto(`/pedidos/${fx.happyId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('tab', { name: 'Checkout' }).click();

    // Item row: produto nome (= lineProdutoId in this fixture) + sku + qty badge.
    await expect(page.getByText(fx.lineProdutoId)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(fx.lineSku)).toBeVisible();
    await expect(page.getByText('1×')).toBeVisible();

    // Frete-at-checkout snapshot: the fixture's freteInicial before the save
    // flipped it to checkFinalizado (CIF / "Em separação" / R$ 25,90).
    await expect(page.getByText('Contratação por conta do Emitente (CIF)')).toBeVisible();
    await expect(page.getByText('Em separação')).toBeVisible();
    await expect(page.getByText(/R\$\s*25,90/)).toBeVisible();

    // Responsável: the logged-in SU account resolved from the checkout doc's
    // usuarioCheckoutFretePedidoOuterRef — permission-gated text must NOT show.
    await expect(page.getByText(/Sem permissão/)).toHaveCount(0);
  });

  test('kit: a whole-kit scan completes the kit line', async ({ page }) => {
    await installRouteStubs(page);
    await loadPedido(page, fx.kitPedidoNumero);

    await expect(page.getByText('Produtos esperados (1)')).toBeVisible({ timeout: 30_000 });

    // Scanning the KIT's own SKU once = a whole-kit scan → completes the line.
    await scan(page, fx.kitSku);
    await expect(page.getByText('Produtos lançados (1)')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Todos os produtos já foram lançados.')).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Checkout salvo')).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(
        async () => {
          const doc = await readCheckout(fx.kitPedidoId);
          return ((doc?.itensCheckout ?? []) as unknown[]).length;
        },
        { timeout: 20_000 },
      )
      .toBe(1);
  });

  test('wrong product: an unexpected produto logs "Produto não esperado"', async ({ page }) => {
    await installRouteStubs(page);
    await loadPedido(page, fx.wrongNumero);

    // Scan a valid produto that is NOT on this pedido. It resolves via the
    // Firestore fallback, so the engine reaches it and writes the exact legacy
    // error string (a code resolving to NO produto would say "não encontrado").
    await scan(page, fx.extraSku);
    await expect(page.getByText('Produtos lançados (1)')).toBeVisible({ timeout: 15_000 });

    // The error string lives in the row's alert-icon Tooltip label (not inline
    // text), so hover the icon to reveal it. After a wrong-product scan the only
    // alert-circle on the loaded screen is this error row's.
    await page.locator('.tabler-icon-alert-circle').first().hover();
    await expect(page.getByText('Produto não esperado')).toBeVisible({ timeout: 10_000 });

    // Deliberately do NOT save — an unresolved error row blocks the save gate.
  });

  test('wrong-label reprint regression: reprint targets the ROW’s pedido', async ({ page }) => {
    // ── The legacy bug this guards against ────────────────────────────────────
    // In the old Flutter checkout, the "Outros Checkouts" list was an un-keyed
    // ListView. When the live stream re-emitted, rows shifted and the mounted
    // reprint handler for slot N rebound to a NEIGHBOURING checkout — so opening
    // one row's reprint fired ANOTHER pedido's shipping label. The Melhor Envio
    // `/imprimir` payload carries no pedidoId, so the `printLabelId` IS the
    // pedido identity: if the reprint ever targeted the wrong (most-recent)
    // pedido, the intercepted label id would be B's, not A's.
    const stubs = await installRouteStubs(page);

    // Check out A, then B — so B is the NEWEST row (first) in the live list and A
    // is a NON-first row.
    await loadPedido(page, fx.pedidoANumero);
    await scan(page, fx.lineSku);
    await expect(page.getByText('Produtos lançados (1)')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Checkout salvo')).toBeVisible({ timeout: 30_000 });

    await loadPedido(page, fx.pedidoBNumero);
    await scan(page, fx.lineSku);
    await expect(page.getByText('Produtos lançados (1)')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Checkout salvo')).toBeVisible({ timeout: 30_000 });

    // Bring the sidebar back by loading B again (now checked out). The "Outros
    // checkouts" panel lists [B (newest), A] scoped to this operator.
    await loadPedido(page, fx.pedidoBNumero);
    await expect(page.getByText('Outros checkouts')).toBeVisible({ timeout: 30_000 });

    // Open A's row — NOT the first row — captured as a frozen view-model.
    const rowA = page.getByRole('button', { name: new RegExp(`^${fx.pedidoANumero}\\b`) });
    await expect(rowA).toBeVisible({ timeout: 30_000 });
    await rowA.click();
    await expect(page.getByText(`Reimpressão — Pedido ${fx.pedidoANumero}`)).toBeVisible({
      timeout: 15_000,
    });

    // Isolate the reprint's network call from the two saves' post-save prints.
    stubs.freightImprimir.length = 0;
    await page.getByRole('button', { name: 'Reimprimir Frete' }).click();

    // The reprint re-fetched A's LIVE frete and printed A's label — exactly once.
    await expect.poll(() => stubs.freightImprimir.length, { timeout: 20_000 }).toBe(1);
    expect(stubs.freightImprimir[0]!.printLabelId).toBe(fx.labelA);
    expect(stubs.freightImprimir[0]!.printLabelId).not.toBe(fx.labelB);
  });

  test('120-item bulk: loads, scans every line, saves 120 itensCheckout', async ({ page }) => {
    // 120 scans each drive a React commit; give the whole flow room.
    test.setTimeout(180_000);
    await installRouteStubs(page);
    await loadPedido(page, fx.bulkNumero);

    await expect(page.getByText('Produtos esperados (120)')).toBeVisible({ timeout: 60_000 });

    for (const sku of fx.bulkSkus) {
      await scan(page, sku);
    }
    await expect(page.getByText('Produtos lançados (120)')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Todos os produtos já foram lançados.')).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Checkout salvo')).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(
        async () => {
          const doc = await readCheckout(fx.bulkId);
          return ((doc?.itensCheckout ?? []) as unknown[]).length;
        },
        { timeout: 30_000 },
      )
      .toBe(120);
  });
});
