import { cleanupE2EDocs, runTeardown } from '@delfrance/test-fixtures';

/**
 * Playwright globalTeardown: removes all e2e fixtures from staging.
 *
 *  - `runTeardown()` deletes every collection prefixed with this run's
 *    namespace (e.g. `e2e_local_grupoEconomico`).
 *  - `cleanupE2EDocs(path, prefix)` sweeps real collections (`clientes`,
 *    `categorias`) for stray docs whose id starts with `e2e-`, in case a
 *    spec failed before its own afterEach cleanup.
 */
export default async function globalTeardown() {
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
