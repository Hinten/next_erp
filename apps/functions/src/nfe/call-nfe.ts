/**
 * Authenticated call into the `apps/nfe` API host from a Cloud Function.
 *
 * `apps/nfe` is a PUBLIC App Hosting backend that enforces OIDC at the app layer
 * (`verifyServiceCaller` — checks `aud` + a service-account allow-list), so a
 * Function reaching it must present a Google **OIDC identity token** whose `aud`
 * is the exact target URL and whose `email` is this function's runtime service
 * account (which the operator adds to apps/nfe's `NFE_TASK_SA_EMAILS`).
 *
 * The token is minted from the **GCE metadata server** using the function's own
 * runtime SA identity — no extra dependency and no extra IAM (a service account
 * can always mint its own identity token for an arbitrary audience). We
 * deliberately avoid `google-auth-library` here: it is not an `apps/functions`
 * dependency (pnpm's strict linking would not resolve it), and the metadata call
 * is all we need on GCP. This keeps the deploy's minimal `package.json` (only
 * firebase-admin / firebase-functions / sharp) untouched.
 *
 * `NFE_BASE_URL` (apps/nfe's public base, NO trailing slash) is inlined at build
 * time by `build.mjs`'s esbuild `define`, exactly like `FUNCTIONS_REGION`; set it
 * in the deploy shell. It MUST equal apps/nfe's own `NFE_BASE_URL` so the
 * audience this function mints matches the audience apps/nfe validates.
 */

/** GCE metadata endpoint that mints an OIDC identity token for the instance SA. */
const METADATA_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

/** Mint an OIDC identity token whose `aud` is `audience`, via the metadata server. */
async function mintIdToken(audience: string): Promise<string> {
  const res = await fetch(`${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}`, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!res.ok) {
    throw new Error(`metadata identity token request failed: HTTP ${res.status}`);
  }
  return (await res.text()).trim();
}

export interface PostNfeResult {
  readonly status: number;
  readonly ok: boolean;
}

/**
 * POST `body` (as JSON) to `${NFE_BASE_URL}${path}` with a fresh OIDC bearer
 * token whose audience is that exact URL. Returns only the response status — the
 * caller decides whether a non-2xx warrants a retry. This layer never reads the
 * response body (it may carry SEFAZ XML/diagnostics — keep it out of logs).
 */
export async function postNfe(path: string, body: unknown): Promise<PostNfeResult> {
  const base = process.env.NFE_BASE_URL;
  if (!base) {
    throw new Error(
      'NFE_BASE_URL is not set — inline it at build (build.mjs esbuild `define`) ' +
        'with the apps/nfe public base URL.',
    );
  }
  const url = `${base}${path}`;
  const token = await mintIdToken(url);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, ok: res.ok };
}
