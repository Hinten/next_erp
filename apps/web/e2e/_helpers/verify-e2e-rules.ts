import { namespace } from '@delfrance/test-fixtures';

const IDENTITY_TOOLKIT_SIGN_IN_URL =
  'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';

interface SignInWithPasswordResponse {
  idToken: string;
}

/**
 * Fails fast, before any Playwright spec runs (and before the login-retry loop
 * below it in `globalSetup`), when the DEPLOYED staging Firestore ruleset does
 * not grant this run's `e2e_<runId>_*` namespace — instead of a confusing
 * per-test `PERMISSION_DENIED` mid-suite (#160, #172).
 *
 * Signs the already-minted ephemeral e2e user in and probes a doc through the
 * real Identity Toolkit + Firestore REST APIs — never the Admin SDK, which
 * bypasses rules entirely — so this exercises exactly what a real client
 * request sees. The probe collection is `${namespace()}_probe`, so it is swept
 * for free by `runTeardown()`, which already clears every `${namespace()}_*`
 * collection.
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
  const probeUrl =
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}` +
    `/documents/${namespace()}_probe/probe`;
  const headers = { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' };

  const writeRes = await fetch(probeUrl, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: { ping: { booleanValue: true } } }),
  });
  await assertRuleCoverage(writeRes, 'write');

  const readRes = await fetch(probeUrl, { headers });
  await assertRuleCoverage(readRes, 'read');
}

async function signInForIdToken(email: string, password: string, apiKey: string): Promise<string> {
  const res = await fetch(`${IDENTITY_TOOLKIT_SIGN_IN_URL}?key=${apiKey}`, {
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
  return body.idToken;
}

async function assertRuleCoverage(res: Response, op: 'write' | 'read'): Promise<void> {
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
