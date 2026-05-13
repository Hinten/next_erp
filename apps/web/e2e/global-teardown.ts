import { cleanupE2EDocs, runTeardown } from '@delfrance/test-fixtures';

/**
 * Playwright globalTeardown: removes all e2e fixtures from staging.
 *
 *  - `runTeardown()` deletes every collection prefixed with this run's
 *    namespace (e.g. `e2e_local_grupoEconomico`).
 *  - `cleanupE2EDocs(path, prefix)` sweeps real collections (`clientes`,
 *    `categorias`) for stray docs whose id starts with `e2e-`, in case a
 *    spec failed before its own afterEach cleanup.
 *
 * Mirrors the graceful degradation in globalSetup: when the Firebase
 * Admin env isn't configured we skip the teardown entirely. Without it
 * `runTeardown()` would throw on `getServiceAccount()`, failing the
 * whole job even when every spec passed (smoke specs don't need auth).
 */
export default async function globalTeardown() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const serviceAccount =
    process.env.FIREBASE_SERVICE_ACCOUNT ?? process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!projectId || !serviceAccount) {
    // eslint-disable-next-line no-console
    console.warn(
      '[globalTeardown] skipping — FIREBASE_PROJECT_ID and ' +
        'FIREBASE_SERVICE_ACCOUNT(_PATH) must be set to reach the Admin SDK.',
    );
    return;
  }

  await runTeardown();
  const collections = ['clientes', 'categorias'];
  for (const c of collections) {
    const deleted = await cleanupE2EDocs(c, 'e2e-');
    if (deleted > 0) {
      // eslint-disable-next-line no-console
      console.log(`[globalTeardown] swept ${deleted} stray e2e docs from ${c}/`);
    }
  }
}
