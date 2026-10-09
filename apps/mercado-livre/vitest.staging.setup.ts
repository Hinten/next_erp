/**
 * Setup for the Mercado Livre STAGING suite (`test:staging`). Three jobs, each
 * guarding a way this suite could report GREEN while proving nothing — or reach
 * something it must never reach.
 */

/**
 * Does this run carry staging credentials? Exported so every suite skips on the
 * SAME predicate this file's gate fails on — a suite deriving its own would let
 * the two disagree, and then the gate guards nothing.
 */
export const STAGING =
  Boolean(process.env.FIREBASE_PROJECT_ID) &&
  Boolean(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_PATH);

/**
 * (1) The fail-loud gate.
 *
 * Every suite here is `describe.skipIf(!STAGING)`, so without credentials they
 * all skip — and vitest still exits 0, because its success check counts
 * COLLECTED files, not executed tests. Locally that is the right behaviour (a
 * bare `pnpm test:staging` with no `.env.local` should skip quietly); in CI it
 * would be a green check that touched nothing. `ML_STAGING_REQUIRED=1` is set by
 * the workflow so the gate does not rest on `CI` alone — the same pairing as
 * `REQUIRE_EMULATOR` in vitest.firestore.setup.ts.
 */
if (!STAGING && (process.env.CI || process.env.ML_STAGING_REQUIRED === '1')) {
  throw new Error(
    'test:staging ran without staging credentials — it needs FIREBASE_PROJECT_ID plus ' +
      'FIREBASE_SERVICE_ACCOUNT (inline JSON) or FIREBASE_SERVICE_ACCOUNT_PATH. In CI they come ' +
      'from the FIREBASE_PROJECT_ID_STAGING / FIREBASE_SERVICE_ACCOUNT_STAGING secrets (see ' +
      '.github/workflows/ci-mercado-livre.yml); locally, from the repo-root .env.local.',
  );
}

/**
 * (2) Refuse the emulator.
 *
 * The Admin SDK reroutes silently to `FIRESTORE_EMULATOR_HOST` whenever it is
 * set, and the emulator is STANDARD edition — the exact thing this suite exists
 * NOT to be. Under `emulators:exec`, or with a stray value in `.env.local`, every
 * query would "pass" against a database that auto-creates indexes, and the plan
 * checks would die on the emulator's missing pipelines instead of saying why.
 */
if (process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    'test:staging must reach the REAL staging Firestore (Enterprise), but ' +
      `FIRESTORE_EMULATOR_HOST=${process.env.FIRESTORE_EMULATOR_HOST} would reroute every ` +
      'Admin SDK call to the Standard-edition emulator. Unset it (do not run this suite under ' +
      'firebase emulators:exec).',
  );
}

/**
 * (3) The network allow-list.
 *
 * This suite holds Firebase credentials and imports Mercado Livre modules; it
 * must never reach api.mercadolibre.com — ML has no sandbox and its
 * refresh_token is single-use, so one stray call from a CI run could rotate the
 * token the deployed staging backend holds. Firestore itself speaks gRPC (not
 * `fetch`) and the token mint goes to Google, so only Google API hosts and
 * localhost pass; anything else throws. A test may still stub `fetch` itself.
 */
const realFetch = globalThis.fetch;

function hostPermitido(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === 'googleapis.com' ||
    hostname.endsWith('.googleapis.com') ||
    hostname === 'metadata.google.internal'
  );
}

globalThis.fetch = (async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const { hostname } = new URL(url);
  if (!hostPermitido(hostname)) {
    throw new Error(
      `test:staging may only reach Google APIs — outbound fetch to ${hostname} is blocked. ` +
        'Mercado Livre has no sandbox and its refresh_token is single-use; stub fetch in the ' +
        'test instead.',
    );
  }
  return realFetch(input, init);
}) as typeof globalThis.fetch;
