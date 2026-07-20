import { expect, test } from '@playwright/test';

/**
 * LOCAL-ONLY perf + leak smoke for the checkout screen against a 1000-line-item
 * pedido. It is NOT run by any CI workflow: it belongs to the `local-perf`
 * Playwright project (see playwright.config.ts), which is collected only by an
 * explicit `--project=local-perf` — and no workflow passes that. Wall-time and
 * DOM-node budgets are machine-dependent, so CI gates the scan ALGORITHM instead
 * via the op-count test in `@delfrance/schemas`
 * (`pedido/pureLogic/checkoutEngine.perf.test.ts`).
 *
 * Run it locally (dev server, so the dev-only harness route is live) with:
 *   pnpm --filter @delfrance/web exec playwright test --project=local-perf
 *
 * It drives the dev harness route `/despacho/checkout/harness`, which builds a
 * fully in-memory 1000-item pedido via the fixture seam and auto-loads it, then:
 *  1. clicks "Auto-scan all" and asserts the reported wall-time is under a
 *     (generous) smoke budget and that all 1000 scans registered;
 *  2. cycles the pedido 5× (full remount + reload each time) and asserts the
 *     live DOM node count doesn't balloon — i.e. remounts don't leak subtrees.
 */
test.describe('checkout screen — 1000-item perf + leak (LOCAL ONLY)', () => {
  // 1000 scans each trigger a React commit in a dev build; give the spec room.
  test.setTimeout(120_000);

  test('auto-scans 1000 items under budget and does not leak across reloads', async ({ page }) => {
    await page.goto('/despacho/checkout/harness');

    // Loaded state: the harness auto-typed the pedido id into the finder and
    // submitted it, so the scan input is visible and the expected pane lists all
    // 1000 lines. `Pedido Nº HARNESS-0` is the seed-0 fixture's número.
    const scanInput = page.getByPlaceholder(/^Bipe o código/);
    await expect(scanInput).toBeVisible({ timeout: 60_000 });
    // The loaded pedido header is a link named "Pedido Nº HARNESS-<seed>" — a
    // unique, unambiguous per-cycle signal (avoids getByText multi-matches).
    await expect(page.getByRole('link', { name: /HARNESS-0\b/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Produtos esperados \(1000\)/)).toBeVisible({ timeout: 30_000 });

    // ── Perf: auto-scan all 1000 barcodes ──────────────────────────────────
    await page.getByRole('button', { name: 'Auto-scan all' }).click();

    // The harness sets `window.__harnessLastScanMs` when the scan loop finishes.
    await page.waitForFunction(
      () => typeof (window as { __harnessLastScanMs?: number }).__harnessLastScanMs === 'number',
      undefined,
      { timeout: 90_000 },
    );
    // Correctness: every scan registered — the audit log grew to 1000 rows and
    // the expected pane emptied.
    await expect(page.getByText(/Produtos lançados \(1000\)/)).toBeVisible({ timeout: 30_000 });

    const scanMs = await page.evaluate(() => {
      const w = window as { __harnessLastScanMs?: number };
      return w.__harnessLastScanMs ?? Number.POSITIVE_INFINITY;
    });
    // Local SMOKE budget, NOT an SLA. The harness yields to React between every
    // scan (so each scan commits, like a real wedge), so the wall-time is
    // dominated by 1000 dev-build React commits + task yields — a few seconds on
    // a healthy machine. The wide 15s ceiling still trips a gross regression
    // (e.g. a quadratic engine or un-virtualized panes re-rendering all 1000
    // rows per scan would run tens of seconds).
    expect(scanMs).toBeLessThan(15_000);

    // ── Leak: cycle the pedido 5× and assert DOM nodes stay bounded ─────────
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.enable');
    const readNodeCount = async (): Promise<number> => {
      // Collect first so only RETAINED (leaked) detached nodes are still counted,
      // trimming GC-timing noise from the comparison.
      await cdp.send('HeapProfiler.collectGarbage');
      const res = (await cdp.send('Performance.getMetrics')) as unknown as {
        metrics: Array<{ name: string; value: number }>;
      };
      return res.metrics.find((m) => m.name === 'Nodes')?.value ?? 0;
    };

    const baseline = await readNodeCount();

    const cycleBtn = page.getByRole('button', { name: 'Cycle pedido' });
    for (let i = 1; i <= 5; i++) {
      await cycleBtn.click();
      // Each cycle fully remounts CheckoutScreen and auto-loads a FRESH pedido
      // (número `HARNESS-<i>`), so this waits for the genuinely new load — no
      // stale-match race, since every cycle's número is distinct.
      await expect(page.getByRole('link', { name: new RegExp(`HARNESS-${i}\\b`) })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(/Produtos esperados \(1000\)/)).toBeVisible({ timeout: 30_000 });
    }

    const after = await readNodeCount();
    // A genuine per-cycle leak (retained detached subtrees) grows Nodes roughly
    // linearly with cycles; a healthy remount stays flat. 1.5× baseline is a
    // wide band that still catches a real 5-cycle leak (which would ~6× the
    // screen's node footprint).
    expect(after).toBeLessThan(baseline * 1.5);
  });
});
