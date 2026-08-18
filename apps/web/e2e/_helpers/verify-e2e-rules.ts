import { E2E_PROBE_COLLECTION, e2eRunId } from '@delfrance/test-fixtures';

const IDENTITY_TOOLKIT_SIGN_IN_URL =
  'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';

interface SignInWithPasswordResponse {
  idToken: string;
}

/**
 * Attempts per probe request, and the base of the exponential backoff between
 * them (250ms, then 500ms) — the same shape the Mercado Livre client uses.
 */
const PROBE_MAX_ATTEMPTS = 3;
const PROBE_RETRY_BASE_MS = 250;

/**
 * `fetch` with a bounded retry for TRANSPORT failures only.
 *
 * This runs from `globalSetup`, so anything thrown here fails the whole
 * Playwright invocation **before a single spec runs** — and `E2E gate
 * (cadastros)` is a required check, so one TCP reset reds a PR for a reason
 * that has nothing to do with the PR. Observed 2026-08-18 on run 32156961332
 * attempt 1: `TypeError: fetch failed` / `[cause]: read ECONNRESET`, zero specs
 * executed; attempt 2 passed unchanged, which is the proof it was transient.
 *
 * Only a fetch THROW retries. `fetch` rejects exactly when no HTTP exchange
 * completed at all (connection reset, DNS, TLS), which Node's undici surfaces
 * as a `TypeError`. Every HTTP RESPONSE resolves and is handed straight back on
 * the FIRST answer — a 403 rules denial, a 400 sign-in failure, a 500 — because
 * those are precisely the signals this probe exists to surface. Retrying one
 * would only turn a real ruleset regression into a slow real ruleset
 * regression, so `assertRuleCoverage` always sees the first response.
 */
async function fetchWithTransportRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (err) {
      // Narrowed on `TypeError`, never on `Error` — `Error` is the parent of
      // every exception, so retrying on it would silently re-run genuine
      // programming bugs too (root CLAUDE.md critical rule 6). Anything else
      // rethrows on the spot.
      if (!(err instanceof TypeError) || attempt >= PROBE_MAX_ATTEMPTS) throw err;
      // The global `setTimeout`, not `node:timers/promises`: only the global one
      // is patched by the unit test's fake timers.
      await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
  }
}

/**
 * Fails fast, before any Playwright spec runs (and before the login-retry loop
 * below it in `globalSetup`), when the DEPLOYED staging Firestore ruleset does
 * not grant the `e2e_`-prefixed namespace — instead of a confusing per-test
 * `PERMISSION_DENIED` mid-suite (#160, #172).
 *
 * Signs the already-minted ephemeral e2e user in and probes a doc through the
 * real Identity Toolkit + Firestore REST APIs — never the Admin SDK, which
 * bypasses rules entirely — so this exercises exactly what a real client
 * request sees.
 *
 * Write, read, then **delete**, all as the client. The delete is not just
 * cleanup: the rule is `allow read, write`, and in Firestore rules `write`
 * covers create/update/delete, so probing it asserts a permission the suite
 * actually depends on. It also collapses the leak window — the probe used to
 * survive until `globalTeardown` (skipped entirely on a cancelled job), and now
 * lives about a second.
 *
 * `startedAt` is rewritten on every PATCH, and the cross-run sweep gates on it
 * rather than on `createTime`: `GITHUB_RUN_ID` is stable across re-run attempts
 * and a write to an existing doc PRESERVES `createTime`, so a job re-run a day
 * later would otherwise look a day stale to a concurrent sweeper — which is a
 * different run, so the run-id gate would not save it either.
 */
export async function verifyE2ENamespaceAccess(email: string, password: string): Promise<void> {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const databaseId = process.env.NEXT_PUBLIC_FIREBASE_DATABASE_ID?.trim() || 'default';
  if (!apiKey || !projectId) {
    throw new Error(
      '[verify-e2e-rules] missing NEXT_PUBLIC_FIREBASE_API_KEY / ' +
        'NEXT_PUBLIC_FIREBASE_PROJECT_ID — cannot probe the deployed staging ruleset.',
    );
  }

  const idToken = await signInForIdToken(email, password, apiKey);
  // `encodeURIComponent` because the run id lands in a URL PATH segment: a value
  // carrying `../` would be normalized by the HTTP layer and could retarget the
  // DELETE below at a real staging document, which the e2e user (granted every
  // permission bit) would be allowed to remove. Not reachable today —
  // GITHUB_RUN_ID is runner-provided and no workflow uses `pull_request_target`
  // — but the encoding is free.
  const probeUrl =
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}` +
    `/documents/${E2E_PROBE_COLLECTION}/${encodeURIComponent(e2eRunId())}`;
  const headers = { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' };

  const writeRes = await fetchWithTransportRetry(probeUrl, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      fields: {
        ping: { booleanValue: true },
        // RFC3339 rather than an epoch number: `historicoFtIni.data` is ms while
        // `historicoEstadoPedido.data` is µs in this repo, and a Timestamp has no
        // unit to get wrong (root CLAUDE.md, critical rule 7).
        startedAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  await assertRuleCoverage(writeRes, 'write');

  const readRes = await fetchWithTransportRetry(probeUrl, { headers });
  await assertRuleCoverage(readRes, 'read');

  const deleteRes = await fetchWithTransportRetry(probeUrl, { method: 'DELETE', headers });
  await assertRuleCoverage(deleteRes, 'delete');
}

async function signInForIdToken(email: string, password: string, apiKey: string): Promise<string> {
  const res = await fetchWithTransportRetry(`${IDENTITY_TOOLKIT_SIGN_IN_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!res.ok) {
    throw new Error(
      `[verify-e2e-rules] could not sign the ephemeral e2e user in to probe Firestore ` +
        `rules: ${res.status} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as SignInWithPasswordResponse;
  if (!body.idToken) {
    throw new Error(
      '[verify-e2e-rules] Identity Toolkit sign-in returned no idToken for the ephemeral ' +
        'e2e user — cannot probe Firestore rules without one.',
    );
  }
  return body.idToken;
}

async function assertRuleCoverage(res: Response, op: 'write' | 'read' | 'delete'): Promise<void> {
  if (res.ok) return;
  if (res.status === 403) {
    throw new Error(
      `[verify-e2e-rules] staging ruleset does not cover e2e namespaces (${op} denied); ` +
        'redeploy the --e2e variant: pnpm --filter @delfrance/rules-gen gen:rules:e2e, ' +
        'then deploy firestore.e2e.rules to the staging project.',
    );
  }
  throw new Error(
    `[verify-e2e-rules] unexpected ${res.status} probing Firestore rules (${op}): ` +
      (await res.text()),
  );
}
