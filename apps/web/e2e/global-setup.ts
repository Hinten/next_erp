import { type FullConfig, chromium, request } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
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
 * Happy path:
 *   1. Seed the namespaced grupoEconomico (idempotent).
 *   2. Ensure the e2e Firebase Auth user exists with the configured password.
 *   3. Grant the user all permission bits + tenant claim via setCustomUserClaims.
 *   4. Launch a chromium context, drive the login form, and persist the
 *      resulting Firebase IndexedDB/localStorage to `storageState`.
 *
 * Graceful degradation: if any of the required secrets are missing
 * (E2E_USER_EMAIL/PASSWORD, FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT)
 * we write an empty storageState and return. The unauthenticated smoke
 * specs (`login.smoke`, `auth-guard.smoke`) still run; every other spec
 * checks `requiresAuthEnv()` in `beforeAll` and skips itself, so CI stays
 * green while clearly signalling that the test user wasn't configured.
 */
export default async function globalSetup(config: FullConfig) {
  const email = process.env.E2E_USER_EMAIL;
  const password = process.env.E2E_USER_PASSWORD;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const serviceAccount =
    process.env.FIREBASE_SERVICE_ACCOUNT ?? process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

  const storageStatePath = config.projects[0]?.use.storageState as string | undefined;
  if (!storageStatePath || typeof storageStatePath !== 'string') {
    throw new Error('Playwright project must declare a `use.storageState` path.');
  }
  await mkdir(dirname(storageStatePath), { recursive: true });

  // --- Graceful degradation ----------------------------------------------
  const missing: string[] = [];
  if (!email) missing.push('E2E_USER_EMAIL');
  if (!password) missing.push('E2E_USER_PASSWORD');
  if (!projectId) missing.push('FIREBASE_PROJECT_ID');
  if (!serviceAccount) missing.push('FIREBASE_SERVICE_ACCOUNT(_PATH)');

  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n[globalSetup] skipping auth setup — missing env: ${missing.join(', ')}.\n` +
        `              Auth-requiring specs (all-pages, CRUD) will skip themselves.\n` +
        `              Configure these as repo secrets to enable the full suite.\n`,
    );
    await writeFile(
      storageStatePath,
      JSON.stringify({ cookies: [], origins: [] }, null, 2),
      'utf8',
    );
    return;
  }

  // --- Happy path --------------------------------------------------------
  const { namespace } = await seed();
  const user = await ensureTestUser(email!, password!);
  // Always rewrite the password so a stale account from a previous run with
  // a different secret still works.
  await setUserPassword(user.uid, password!);
  await grantAllPerms(email!, { extraClaims: { grupoEconomico: 'seed' } });

  const baseURL =
    process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

  // Wait for the web server to be reachable. Playwright's webServer block
  // already does this for `webServer.port`, but in CI globalSetup can race
  // ahead. A tiny ping-and-retry guards against that without bloating the
  // happy path.
  await waitForServer(baseURL);

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email!);
  await page.getByLabel('Senha').fill(password!);
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
