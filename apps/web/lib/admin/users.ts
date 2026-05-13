/**
 * HTTP client for the apps/integrations admin endpoints. Calls require a
 * Firebase ID token from the current user — the server verifies it plus a
 * cascade-permission guard: the caller cannot grant bits they don't hold.
 *
 * Base URL: `NEXT_PUBLIC_INTEGRATIONS_URL` (e.g. `http://localhost:3001` in dev,
 * `https://api-<env>.web.app` in deploy). In dev, falls back to
 * `http://localhost:3001` so `pnpm dev` at the repo root "just works" without
 * extra env config (both apps come up in parallel — web :3000, integrations
 * :3001). Production builds without the env set will hit same-origin and 404
 * — that's a misconfiguration, not a runtime fallback.
 */

const BASE =
  process.env.NEXT_PUBLIC_INTEGRATIONS_URL ??
  (process.env.NODE_ENV === 'development' ? 'http://localhost:3001' : '');

export interface CreateUserPayload {
  email: string;
  nome: string;
  senha: string;
  cargos: string[];
  colaborador?: boolean;
  isSuperUser?: boolean;
}

export interface CreateUserResult {
  uid: string;
}

async function call<T>(
  path: string,
  init: RequestInit,
  idToken: string,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      'content-type': 'application/json',
      authorization: `Bearer ${idToken}`,
    },
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ?? '';
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // SyntaxError: non-JSON response body — fall back to status text.
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function createUser(
  payload: CreateUserPayload,
  idToken: string,
): Promise<CreateUserResult> {
  return call<CreateUserResult>(
    '/api/admin/users',
    { method: 'POST', body: JSON.stringify(payload) },
    idToken,
  );
}

export function refreshClaims(
  uid: string,
  idToken: string,
): Promise<{ uid: string; permissions: string }> {
  return call<{ uid: string; permissions: string }>(
    `/api/admin/users/${encodeURIComponent(uid)}/claims`,
    { method: 'POST' },
    idToken,
  );
}
