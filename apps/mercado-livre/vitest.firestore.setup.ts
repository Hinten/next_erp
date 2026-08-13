/**
 * Setup for the Mercado Livre Firestore integration lane. Three jobs, each
 * guarding a way this lane could report GREEN while proving nothing.
 */

/**
 * (1) The fail-loud gate.
 *
 * Every suite here is wrapped in `describe.skipIf(!EMULATED)`, so without the
 * emulator they all skip — and vitest still exits 0, because its success check
 * counts COLLECTED files, not executed tests. A misconfigured job would then be
 * green having asserted nothing. Locally a bare `pnpm test:firestore` should
 * still skip quietly; in CI it must throw.
 *
 * Copied from packages/rules-gen/test/helpers.ts, which solved this first.
 * `REQUIRE_EMULATOR` is set by the workflow so the gate does not rely on `CI`
 * alone (a test must not assume its own env — and the inverse failure, a local
 * run silently proving nothing, is real too).
 */
export const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

if (!EMULATED && (process.env.CI || process.env.REQUIRE_EMULATOR)) {
  throw new Error(
    'test:firestore ran without FIRESTORE_EMULATOR_HOST — wrap it in ' +
      '`firebase emulators:exec --config firebase.mercado-livre.json --only firestore` ' +
      '(see .github/workflows/ci-mercado-livre.yml).',
  );
}

/**
 * (2) Pin the project + database the Admin SDK resolves to.
 *
 * `emulators:exec` exports GCLOUD_PROJECT and FIREBASE_CONFIG, and
 * `resolveProjectId` (lib/firebase/admin.ts) reads FIREBASE_PROJECT_ID →
 * GOOGLE_CLOUD_PROJECT → FIREBASE_CONFIG — so it WOULD find `demo-erp` via the
 * last one. Pinning it explicitly stops the lane depending on that CLI detail,
 * and stops a developer's `.env.local` FIREBASE_PROJECT_ID from splitting the
 * emulator into a second namespace mid-run.
 *
 * FIREBASE_DATABASE_ID matters more than it looks: the database is literally
 * named `default`, not `(default)`. In PRODUCTION the wrong id fails every op
 * with `5 NOT_FOUND`; in the EMULATOR `(default)` silently exists and
 * auto-creates — so a mis-targeted database is invisible here, and every
 * "not found" / "empty" / "no errors" assertion would pass against it. That is
 * why each suite must also carry a POSITIVE existence assertion.
 */
if (EMULATED) {
  process.env.FIREBASE_PROJECT_ID = 'demo-erp';
  process.env.FIREBASE_DATABASE_ID ??= 'default';
}

/**
 * (3) The network kill-switch.
 *
 * GitHub runners have egress, so a test that forgets to stub `fetch` would
 * reach the real api.mercadolibre.com — with real rate limits and, worse, a
 * real single-use refresh-token rotation. This makes "offline" a property of
 * the LANE rather than of each author's diligence.
 *
 * Scoped to non-local hosts so the Admin SDK's own emulator traffic is
 * untouched, and so a test may still stub `fetch` itself (vi.stubGlobal) for a
 * canned ML response.
 */
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const { hostname } = new URL(url);
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
    throw new Error(
      `ci-mercado-livre is an OFFLINE lane — outbound fetch to ${hostname} is blocked. ` +
        'Mercado Livre has no sandbox and its refresh_token is single-use, so this lane ' +
        'must never reach a real API. Stub fetch in the test instead.',
    );
  }
  return realFetch(input, init);
}) as typeof globalThis.fetch;
