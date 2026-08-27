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

import { z } from 'zod';

import { envelopeDeErro, lerRespostaJson } from '@delfrance/core/wire';

const BASE =
  process.env.NEXT_PUBLIC_INTEGRATIONS_URL ??
  (process.env.NODE_ENV === 'development' ? 'http://localhost:3001' : '');

/**
 * Non-2xx from the admin endpoints.
 *
 * ⚠️ This file used to throw a BARE `Error`, discarding the status entirely, so
 * the caller could not tell a 403 (this operator may not grant that bit) from a
 * 500 (the backend is broken) and offered the same unhelpful message for both.
 */
export class AdminClientHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'AdminClientHttpError';
  }
}

/**
 * Never reached the admin backend.
 *
 * ⚠️ Also new. The raw `TypeError` from `fetch` used to escape straight into the
 * React handler, where it reads as a programming bug rather than "the
 * integrations app is not running" — which, in local dev, is the usual cause.
 */
export class AdminClientNetworkError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AdminClientNetworkError';
  }
}

/** The backend answered 2xx with something that is not the shape we claimed. */
export class AdminClientRespostaInvalidaError extends AdminClientHttpError {
  constructor(
    message: string,
    status: number,
    /** Field PATHS that failed, never values. */
    readonly campos: string[],
  ) {
    super(message, status, 'RESPOSTA_INVALIDA');
    this.name = 'AdminClientRespostaInvalidaError';
  }
}

export interface CreateUserPayload {
  email: string;
  nome: string;
  senha: string;
  cargos: string[];
  colaborador?: boolean;
  isSuperUser?: boolean;
}

export const createUserResultSchema = z.object({ uid: z.string() });
export type CreateUserResult = z.infer<typeof createUserResultSchema>;

export const refreshClaimsResultSchema = z.object({
  uid: z.string(),
  /** BigInt-encoded permission bits — a STRING, to dodge the JS 53-bit limit. */
  permissions: z.string(),
});
export type RefreshClaimsResult = z.infer<typeof refreshClaimsResultSchema>;

/**
 * ⚠️ This helper was the least defended of the six in the repo. Before:
 *
 *  - `(await res.json()) as T` sat OUTSIDE any try, so an empty or non-JSON 2xx
 *    threw a raw `SyntaxError` at the React caller;
 *  - the `fetch` rejection was not wrapped at all, so a network failure arrived
 *    as a bare `TypeError`;
 *  - a non-2xx threw a bare `Error`, dropping the status and the code.
 *
 * All three now match the channel clients: read the text once, narrow, and
 * validate the success body against the schema that describes it.
 */
async function call<S extends z.ZodType>(
  path: string,
  schema: S,
  init: RequestInit,
  idToken: string,
): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        'content-type': 'application/json',
        authorization: `Bearer ${idToken}`,
      },
    });
  } catch (err) {
    throw new AdminClientNetworkError(err instanceof Error ? err.message : 'fetch falhou', err);
  }

  const text = await res.text();

  if (!res.ok) {
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        if (err instanceof SyntaxError) {
          logarCorpoNaoJson(path, res.status, text);
        } else throw err;
      }
    }
    const errBody = envelopeDeErro(parsed);
    throw new AdminClientHttpError(
      errBody?.error ?? `${String(res.status)} ${res.statusText}`,
      res.status,
      errBody?.code ?? null,
    );
  }

  const leitura = lerRespostaJson(text, schema);
  if (leitura.ok) return leitura.data;

  if (leitura.motivo === 'nao-json') {
    logarCorpoNaoJson(path, res.status, leitura.texto);
    throw new AdminClientRespostaInvalidaError(
      `O serviço de administração respondeu HTTP ${String(res.status)} sem um corpo JSON — o ` +
        'pedido não chegou à rota esperada. Atualize a página e, se continuar, avise o suporte.',
      res.status,
      [],
    );
  }

  throw new AdminClientRespostaInvalidaError(
    'O serviço de administração respondeu num formato que este aplicativo não reconhece. ' +
      `Campos inválidos: ${leitura.campos.join(', ')}. Normalmente isso significa que o ` +
      'backend e esta tela estão em versões diferentes — faça o deploy de `apps/integrations` ' +
      'e recarregue a página.',
    res.status,
    leitura.campos,
  );
}

/**
 * Log a body the operator will never see, capped so a whole HTML document
 * cannot flood the console.
 */
function logarCorpoNaoJson(path: string, status: number, corpo: string): void {
  console.error(
    `[admin] resposta não-JSON em ${path} (HTTP ${String(status)})`,
    corpo.slice(0, 500),
  );
}

export function createUser(payload: CreateUserPayload, idToken: string): Promise<CreateUserResult> {
  return call(
    '/api/admin/users',
    createUserResultSchema,
    { method: 'POST', body: JSON.stringify(payload) },
    idToken,
  );
}

export function refreshClaims(uid: string, idToken: string): Promise<RefreshClaimsResult> {
  return call(
    `/api/admin/users/${encodeURIComponent(uid)}/claims`,
    refreshClaimsResultSchema,
    { method: 'POST' },
    idToken,
  );
}
