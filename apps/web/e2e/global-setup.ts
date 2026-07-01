import { type Browser, type FullConfig, type Page, chromium, request } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ensureTestUser, grantAllPerms, seed } from '@delfrance/test-fixtures';
import { e2eUserEmail } from './_helpers/run-id';
import { sweepStaleE2EUsers } from './_helpers/admin-cleanup';

/**
 * Playwright globalSetup: prepares the staging backend once per test run.
 *
 * Happy path:
 *   1. Sweep ephemeral e2e users leaked by crashed prior runs.
 *   2. Seed the namespaced grupoEconomico (idempotent).
 *   3. Create an ephemeral Firebase Auth user for this run — unique email
 *      derived from the run id, random password — and grant it all permission
 *      bits + the tenant claim via setCustomUserClaims. globalTeardown
 *      deletes it. No shared persistent account: parallel-safe, no
 *      `E2E_USER_*` secrets, no password drift.
 *   4. Drive the login form, wait for Firebase to persist the session into
 *      IndexedDB, capture `storageState`, then verify it actually restores an
 *      authenticated session in a fresh context. Retried up to 3×; if no
 *      attempt produces a working storageState we throw — far better than
 *      letting the whole suite run with broken auth and die on test #1.
 *
 * Graceful degradation: if the Admin SDK secrets are missing
 * (FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT) we write an empty
 * storageState and return. The unauthenticated smoke specs (`login.smoke`,
 * `auth-guard.smoke`) still run and pass; the auth-requiring specs
 * (all-pages, CRUD) then fail fast at `/login` — the intended loud signal
 * that the backend wasn't configured.
 */
// This file lives at `apps/web/e2e/global-setup.ts`; the storageState
// path is its sibling. Resolving against the file URL is robust to
// whatever `cwd`/`rootDir` Playwright uses (tested empirically: the
// previous `config.rootDir`-based path resolved to `e2e/e2e/.auth/...`
// because rootDir was the testDir, not the project dir).
const HERE = dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE_PATH = resolve(HERE, '.auth/user.json');

// How many times to (re)drive the login + capture + verify cycle before
// giving up. The capture can race Firebase's async IndexedDB write; a fresh
// attempt almost always wins it.
const AUTH_SETUP_ATTEMPTS = 3;

export default async function globalSetup(_config: FullConfig) {
  // eslint-disable-next-line no-console
  console.log('[globalSetup] starting…');
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const serviceAccount =
    process.env.FIREBASE_SERVICE_ACCOUNT ?? process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  // Emulator mode: `firebase emulators:exec` exports these hosts to the child
  // process (see .github/workflows/e2e-emulator.yml), so the Admin SDK
  // auto-targets the local emulator and NO service account is needed — the
  // seed / ephemeral-user / claim fixtures all talk to the emulator instead of
  // the staging project.
  const emulatorMode = Boolean(
    process.env.FIREBASE_AUTH_EMULATOR_HOST ?? process.env.FIRESTORE_EMULATOR_HOST,
  );

  const storageStatePath = STORAGE_STATE_PATH;
  await mkdir(dirname(storageStatePath), { recursive: true });

  // --- Graceful degradation ----------------------------------------------
  // In emulator mode a service account is intentionally absent (the emulator
  // ignores real credentials); only the project id is still required.
  const missing: string[] = [];
  if (!projectId) missing.push('FIREBASE_PROJECT_ID');
  if (!serviceAccount && !emulatorMode) missing.push('FIREBASE_SERVICE_ACCOUNT(_PATH)');

  if (missing.length > 0) {
    console.warn(
      `\n[globalSetup] skipping auth setup — missing env: ${missing.join(', ')}.\n` +
        `              Auth-requiring specs (all-pages, CRUD) will fail fast at /login.\n` +
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
  // Ephemeral test user: a fresh account per run, deleted by globalTeardown.
  const staleSwept = await sweepStaleE2EUsers();
  if (staleSwept > 0) {
    // eslint-disable-next-line no-console
    console.log(`[globalSetup] swept ${staleSwept} leaked ephemeral e2e user(s)`);
  }
  const email = e2eUserEmail();
  const password = randomUUID();

  const { namespace } = await seed();
  await ensureTestUser(email, password);
  // Grant the permission + tenant claims BEFORE the UI login below: the login
  // mints the ID token that the captured storageState carries, so the claims
  // must already be set or the app would restore a token without them.
  await grantAllPerms(email, { extraClaims: { grupoEconomico: 'seed' } });

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

  // Wait for the web server to be reachable. Playwright's webServer block
  // already does this for `webServer.port`, but in CI globalSetup can race
  // ahead. A tiny ping-and-retry guards against that without bloating the
  // happy path.
  await waitForServer(baseURL);

  const browser = await chromium.launch();
  try {
    for (let attempt = 1; attempt <= AUTH_SETUP_ATTEMPTS; attempt++) {
      const verified = await captureAndVerifyAuth(
        browser,
        baseURL,
        email,
        password,
        storageStatePath,
      ).then(
        (ok) => ok,
        (err) => {
          // A thrown attempt (login timeout, navigation error, …) is just a
          // failed attempt: log it and let the loop retry. Anything that is
          // not an Error subclass shouldn't be swallowed — rethrow it.
          if (!(err instanceof Error)) throw err;
          console.warn(
            `[globalSetup] auth setup attempt ${attempt}/${AUTH_SETUP_ATTEMPTS} ` +
              `threw: ${err.message}`,
          );
          return false;
        },
      );

      if (verified) {
        // eslint-disable-next-line no-console
        console.log(
          `[globalSetup] seeded tenant ${namespace}_grupoEconomico/seed, ` +
            `granted perms to ${email}, storageState -> ${storageStatePath} ` +
            `(verified on attempt ${attempt}/${AUTH_SETUP_ATTEMPTS})`,
        );
        return;
      }

      console.warn(
        `[globalSetup] storageState from attempt ${attempt}/${AUTH_SETUP_ATTEMPTS} ` +
          `did not restore an authenticated session — ` +
          (attempt < AUTH_SETUP_ATTEMPTS ? 'retrying…' : 'giving up.'),
      );
    }

    throw new Error(
      `[globalSetup] could not produce an authenticated storageState after ` +
        `${AUTH_SETUP_ATTEMPTS} attempts: the e2e user logs in but the saved ` +
        `session does not restore. Check the E2E_USER_* secrets and the ` +
        `staging Firebase project before re-running the suite.`,
    );
  } finally {
    await browser.close();
  }
}

/**
 * One full attempt: drive the login form in a fresh context, wait for the
 * Firebase session to land in IndexedDB, persist `storageState`, then verify
 * the saved file actually authenticates. Returns whether verification passed.
 */
async function captureAndVerifyAuth(
  browser: Browser,
  baseURL: string,
  email: string,
  password: string,
  storageStatePath: string,
): Promise<boolean> {
  await captureAuthenticatedState(browser, baseURL, email, password, storageStatePath);
  return verifyStorageState(browser, baseURL, storageStatePath);
}

/**
 * Logs in through the UI and writes `storageState` (cookies + IndexedDB).
 * Crucially waits for Firebase to flush the auth user to IndexedDB *before*
 * capturing — capturing earlier yields a user.json without the
 * `firebase:authUser:*` key, i.e. a session that silently fails to restore.
 */
async function captureAuthenticatedState(
  browser: Browser,
  baseURL: string,
  email: string,
  password: string,
  storageStatePath: string,
): Promise<void> {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await page.goto('/login');
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Senha').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    // Wait for the post-login redirect into the app shell.
    await page.waitForURL('**/inicio', { timeout: 20_000 });
    // The redirect fires as soon as onAuthStateChanged sees the user, but the
    // Firebase SDK persists that session into IndexedDB asynchronously. Wait
    // for the write to land so the storageState capture below can't race it.
    await waitForFirebaseAuthPersisted(page);
    await context.storageState({ path: storageStatePath, indexedDB: true });
  } finally {
    await context.close();
  }
}

/**
 * Resolves once the Firebase `firebaseLocalStorageDb` IndexedDB database holds
 * a `firebase:authUser:*` key — the persisted Auth session. Throws on timeout.
 */
async function waitForFirebaseAuthPersisted(page: Page, timeoutMs = 10_000): Promise<void> {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolveAuth) => {
        const open = indexedDB.open('firebaseLocalStorageDb');
        open.onerror = () => resolveAuth(false);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
            db.close();
            resolveAuth(false);
            return;
          }
          const keysReq = db
            .transaction('firebaseLocalStorage', 'readonly')
            .objectStore('firebaseLocalStorage')
            .getAllKeys();
          keysReq.onerror = () => {
            db.close();
            resolveAuth(false);
          };
          keysReq.onsuccess = () => {
            db.close();
            resolveAuth(
              keysReq.result.some(
                (key) => typeof key === 'string' && key.startsWith('firebase:authUser:'),
              ),
            );
          };
        };
      }),
    undefined,
    { timeout: timeoutMs },
  );
}

/**
 * Opens a fresh context restored from `storageStatePath`, navigates to a
 * protected route and confirms the session restored: the authenticated
 * dashboard renders and the URL did not bounce to `/login`. Mechanism-
 * agnostic — it catches any reason a saved state fails to authenticate.
 */
async function verifyStorageState(
  browser: Browser,
  baseURL: string,
  storageStatePath: string,
): Promise<boolean> {
  const context = await browser.newContext({
    baseURL,
    storageState: storageStatePath,
  });
  try {
    const page = await context.newPage();
    await page.goto('/inicio');
    // The app layout renders this heading only once useRequireAuth has a
    // non-null user; an unrestored session redirects to /login instead.
    const dashboardHeading = page.getByRole('heading', { name: 'Início' });
    const outcome = await Promise.race([
      dashboardHeading.waitFor({ state: 'visible', timeout: 20_000 }).then(
        () => 'authenticated' as const,
        () => 'inconclusive' as const,
      ),
      page.waitForURL('**/login', { timeout: 20_000 }).then(
        () => 'login' as const,
        () => 'inconclusive' as const,
      ),
    ]);
    return outcome === 'authenticated';
  } finally {
    await context.close();
  }
}

async function waitForServer(baseURL: string, timeoutMs = 60_000) {
  const ctx = await request.newContext();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await ctx.get(baseURL, { timeout: 5_000 });
      if (res.ok() || res.status() < 500) return;
    } catch (err) {
      // Network-layer failures (ECONNREFUSED, timeout) are expected while
      // the dev server is still booting — keep polling. Anything that is
      // not an Error subclass shouldn't be ignored: rethrow it.
      if (!(err instanceof Error)) throw err;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Web server at ${baseURL} did not respond within ${timeoutMs}ms.`);
}
