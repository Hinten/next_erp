import { type FullConfig, chromium, request } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ensureTestUser,
  grantAllPerms,
  seed,
  setUserPassword,
} from '@delfrance/test-fixtures';

/**
 * Playwright globalSetup: prepares the staging backend once per test run.
 *
 * Sequence:
 *   1. Seed the namespaced grupoEconomico (idempotent — `tools/test-fixtures`).
 *   2. Ensure the e2e Firebase Auth user exists with the configured password.
 *   3. Grant the user all permission bits + tenant claim via setCustomUserClaims.
 *   4. Launch a chromium context, walk through the login form, and persist
 *      the resulting Firebase IndexedDB/localStorage to `storageState`.
 *
 * Every spec inherits that storageState via playwright.config.ts, so we pay
 * the cost of one real login per run instead of one per test.
 */
export default async function globalSetup(config: FullConfig) {
  const email = process.env.E2E_USER_EMAIL;
  const password = process.env.E2E_USER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'E2E_USER_EMAIL and E2E_USER_PASSWORD must be set for Playwright globalSetup. ' +
        'Locally: copy apps/web/.env.example to .env.local and fill them in. ' +
        'CI: add the matching repository secrets and confirm .github/workflows/ci.yml ' +
        'threads them into the e2e job env block.',
    );
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const serviceAccount =
    process.env.FIREBASE_SERVICE_ACCOUNT ?? process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!projectId || !serviceAccount) {
    throw new Error(
      'FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT(_PATH) must be set so the ' +
        'Admin SDK can mint the test user and seed the tenant. See apps/web/.env.example.',
    );
  }

  // 1. Seed tenant (no-op if already present).
  const { namespace } = await seed();

  // 2. Ensure the test user exists.
  const user = await ensureTestUser(email, password);
  // Always rewrite the password so a stale account from a previous run with
  // a different secret still works.
  await setUserPassword(user.uid, password);

  // 3. Grant claims (permissions + tenant). The `grupoEconomico` claim is
  //    consumed by useTenant() on the web client.
  await grantAllPerms(email, { extraClaims: { grupoEconomico: 'seed' } });

  // 4. Real login via UI so the resulting IndexedDB carries the Firebase
  //    session. Playwright's network blocking is off here — we want the
  //    real Firebase auth round-trip.
  const baseURL =
    process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const storageStatePath = config.projects[0]?.use.storageState as string | undefined;
  if (!storageStatePath || typeof storageStatePath !== 'string') {
    throw new Error('Playwright project must declare a `use.storageState` path.');
  }
  await mkdir(dirname(storageStatePath), { recursive: true });

  // Wait for the web server to be reachable. Playwright's webServer block
  // already does this for `webServer.port`, but in CI globalSetup can race
  // ahead. A tiny ping-and-retry guards against that without bloating the
  // happy path.
  await waitForServer(baseURL);

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // Wait for the post-login redirect into the app shell.
  await page.waitForURL('**/inicio', { timeout: 20_000 });
  await context.storageState({ path: storageStatePath, indexedDB: true });
  await browser.close();

  // eslint-disable-next-line no-console
  console.log(
    `[globalSetup] seeded tenant ${namespace}_grupoEconomico/seed, ` +
      `granted perms to ${email}, storageState -> ${storageStatePath}`,
  );
}

async function waitForServer(baseURL: string, timeoutMs = 60_000) {
  const ctx = await request.newContext();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await ctx.get(baseURL, { timeout: 5_000 });
      if (res.ok() || res.status() < 500) return;
    } catch {
      // server not yet listening — keep polling
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Web server at ${baseURL} did not respond within ${timeoutMs}ms.`);
}
