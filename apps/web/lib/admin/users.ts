/**
 * HTTP client for the apps/integrations admin endpoints. Calls require a
 * Firebase ID token from the current user — the server verifies it and the
 * caller's grupoEconomico + configuracoes.write permission.
 *
 * Base URL: `NEXT_PUBLIC_INTEGRATIONS_URL` (e.g. `http://localhost:3001` in dev,
 * `https://api-<env>.web.app` in deploy). Falls back to relative paths only
 * if `apps/web` ever exposes the same routes — currently it does not.
 */

const BASE = process.env.NEXT_PUBLIC_INTEGRATIONS_URL ?? '';

export interface CreateUserPayload {
  email: string;
  nome: string;
  senha: string;
  cargos: string[];
  colaborador?: boolean;
  isSuperUser?: boolean;
  grupoEconomico: string;
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
    } catch {
      // ignore — fall back to status text
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
