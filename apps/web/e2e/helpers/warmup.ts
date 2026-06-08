import type { Browser } from '@playwright/test';

/**
 * Pre-compile the given routes on the Next dev server before a suite's
 * assertions start. Next 16 dev mode cold-compiles every imported module on
 * first request; in CI that can spike past a test's per-`expect` timeout, so
 * the first navigation in a suite "loses the race" and flakes. Warming the
 * routes in `beforeAll` pays the compile cost once, off the assertion clock.
 *
 * Uses throwaway unauthenticated pages: the client-side auth guard redirects
 * to /login, but the Next server still compiles the route module to serve the
 * GET — which is the expensive part. `waitUntil: 'commit'` returns as soon as
 * the response lands; compilation has already finished server-side by then.
 */
export async function warmRoutes(browser: Browser, routes: string[]): Promise<void> {
  await Promise.all(
    routes.map(async (route) => {
      const page = await browser.newPage();
      try {
        await page.goto(route, { waitUntil: 'commit', timeout: 120_000 });
      } finally {
        await page.close();
      }
    }),
  );
}
