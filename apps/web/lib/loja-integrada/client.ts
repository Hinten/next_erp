'use client';

/**
 * `useLojaIntegradaClient()` — a memoized typed client bound to the current
 * Firebase auth state, talking to the `apps/loja-integrada` conta routes on their
 * own App Hosting backend. The shape of `useWhatsappClient`
 * (`lib/whatsapp/client.ts`): `null` while logged out, so the panel can disable
 * its buttons, and `() => user.getIdToken()` so a refreshed ID token propagates.
 *
 * Four calls, one per route (`apps/loja-integrada/app/api/marketplace/loja-integrada/conta/[id]/…`):
 *
 * | call | route | answer |
 * | --- | --- | --- |
 * | `conta(id)` | `GET …/conta/[id]` | `statusContaLojaIntegradaSchema` |
 * | `salvarCredencial(id, corpo)` | `PUT …/conta/[id]/credencial` | `respostaCredencialLojaIntegradaSchema` |
 * | `renovarValidade(id, corpo)` | `PUT …/conta/[id]/credencial/validade` | `respostaCredencialLojaIntegradaSchema` |
 * | `removerCredencial(id)` | `DELETE …/conta/[id]/credencial` | `respostaRemocaoCredencialLiSchema` |
 *
 * Every answer — the 2xx bodies AND the error envelope — is read against the ONE
 * shared contract in `@delfrance/schemas` (`contaLojaIntegrada.ts`), the same
 * module the routes build their answers with. Nothing here is cast.
 *
 * ## The Personal Token
 *
 * It travels exactly once, in the JSON BODY of the save `PUT`, and nowhere else:
 * never in a URL (the conta id is the only path segment, percent-encoded), never
 * in an error message, never in a log line. The status route never returns it.
 * A request that carried it never logs its response body either — a misbehaving
 * proxy that echoed the request would otherwise put the token on the console.
 *
 * ## Fail closed: an `https:` page never sends to an `http:` backend
 *
 * Every channel client falls back to its `localhost` port when its
 * `NEXT_PUBLIC_*_URL` is missing from a build. For this one the fallback would
 * carry a store's live token in a plain-http body, so {@link resolverBackendLojaIntegrada}
 * refuses that combination and the panel says the backend is not configured. It
 * deliberately keys on the PAGE's protocol rather than on `NODE_ENV`: CI's e2e
 * serves a production build over plain http with no `NEXT_PUBLIC_*_URL` set, and
 * its stubbed-backend cases must keep working.
 *
 * ⚠️ This client retries NOTHING, and the conta query does not either
 * (`retry: false` in the panel): a save is a validation against Loja Integrada,
 * and repeating one is the operator's decision.
 */
import { useMemo } from 'react';
import type { z } from 'zod';
import {
  type CorpoRenovarValidadeLi,
  type CorpoSalvarCredencialLi,
  type RespostaCredencialLojaIntegrada,
  type RespostaRemocaoCredencialLi,
  type StatusContaLojaIntegrada,
  erroContaLojaIntegradaSchema,
  respostaCredencialLojaIntegradaSchema,
  respostaRemocaoCredencialLiSchema,
  statusContaLojaIntegradaSchema,
} from '@delfrance/schemas';
import { lerRespostaJson, resumirCampos } from '@delfrance/core/wire';

import { useAuth } from '@/lib/auth/useAuth';

/** The local dev port of `apps/loja-integrada` (root `CLAUDE.md`, Layout). */
export const DEFAULT_LOJA_INTEGRADA_URL = 'http://localhost:3010';

/** Every conta route hangs off this prefix (`apps/loja-integrada/proxy.ts` allows `/api/marketplace/*`). */
const CONTA_PATH = '/api/marketplace/loja-integrada/conta';

/** Optional detail an error envelope may carry beyond `error` and `code`. */
export interface DetalhesErroLojaIntegrada {
  /** Field PATHS the backend blamed (`issues`), never values. */
  readonly campos?: readonly string[];
  /** The HTTP status Loja Integrada answered a validation with, when there was one. */
  readonly statusLi?: number | null;
  /** The validation call's correlation id, for support. */
  readonly correlationId?: string | null;
}

/** Non-2xx response from the `apps/loja-integrada` backend. */
export class LojaIntegradaClientHttpError extends Error {
  /** Field PATHS only (`issues` on the envelope, or the 2xx paths that failed). */
  readonly campos: readonly string[];
  /** The HTTP status Loja Integrada answered a validation with (`status` on the envelope). */
  readonly statusLi: number | null;
  readonly correlationId: string | null;

  constructor(
    message: string,
    readonly status: number,
    /**
     * The backend's machine code (`CODIGO_ERRO_LI`, or `RESPOSTA_INVALIDA` from
     * the subclass). A plain string: a code a newer backend adds must still
     * reach the caller. ⚠️ Key copy on THIS, never on `status` alone — a 422 is
     * either "Loja Integrada refused the token" or "malformed, never sent".
     */
    readonly code: string | null,
    detalhes: DetalhesErroLojaIntegrada = {},
  ) {
    super(message);
    this.name = 'LojaIntegradaClientHttpError';
    this.campos = detalhes.campos ?? [];
    this.statusLi = detalhes.statusLi ?? null;
    this.correlationId = detalhes.correlationId ?? null;
  }
}

/**
 * The backend answered 2xx and the body was not the shape this app claims — the
 * wrong fields, no body at all, or not JSON.
 *
 * ⚠️ A SUBCLASS of {@link LojaIntegradaClientHttpError}, matching the sibling
 * clients: catch sites narrow to that class and rethrow anything else, so a
 * sibling class would land as an unhandled rejection instead of a message.
 * `code === 'RESPOSTA_INVALIDA'` is what tells the two apart. Narrow it FIRST.
 */
export class LojaIntegradaClientRespostaInvalidaError extends LojaIntegradaClientHttpError {
  constructor(
    message: string,
    /** The real 2xx the backend sent — never a hardcoded 200. */
    status: number,
    /** Field PATHS that failed, never values. */
    campos: readonly string[],
  ) {
    super(message, status, 'RESPOSTA_INVALIDA', { campos });
    this.name = 'LojaIntegradaClientRespostaInvalidaError';
  }
}

/**
 * Network-level failure reaching the backend (or reading its body).
 *
 * ⚠️ The message is a FIXED sentence: the transport's own text stays on
 * `cause`, so nothing a runtime chose to put in it can reach the operator's
 * screen or a log through `err.message`.
 */
export class LojaIntegradaClientNetworkError extends Error {
  constructor(override readonly cause?: unknown) {
    super('Falha de rede ao contatar o backend da Loja Integrada.');
    this.name = 'LojaIntegradaClientNetworkError';
  }
}

export interface LojaIntegradaClient {
  /** The conta's credential status (`PERM.integracao.read`). Never the token. */
  conta(integracaoId: string): Promise<StatusContaLojaIntegrada>;
  /**
   * Validate a Personal Token against Loja Integrada and store it
   * (`PERM.integracao.write`). The body is sent exactly as given, rebuilt by
   * name — `credencialForm.ts` trims the token and supplies `versaoEsperada`.
   */
  salvarCredencial(
    integracaoId: string,
    corpo: CorpoSalvarCredencialLi,
  ): Promise<RespostaCredencialLojaIntegrada>;
  /** Re-validate the STORED token and store a new expiry date (`PERM.integracao.write`). */
  renovarValidade(
    integracaoId: string,
    corpo: CorpoRenovarValidadeLi,
  ): Promise<RespostaCredencialLojaIntegrada>;
  /** Remove the stored token — idempotent and unconditional (`PERM.integracao.write`). */
  removerCredencial(integracaoId: string): Promise<RespostaRemocaoCredencialLi>;
}

/**
 * What to say when the backend answered a non-2xx WITHOUT our JSON envelope —
 * the request never reached one of the conta routes (a proxy page, a platform
 * timeout, a backend without these routes).
 */
export function mensagemHttpLojaIntegrada(status: number): string {
  if (status === 401 || status === 403) {
    return 'Sem permissão para esta operação no backend da Loja Integrada.';
  }
  if (status === 404) {
    return (
      `O backend da Loja Integrada não respondeu por esta rota (HTTP ${String(status)}). ` +
      'Atualize a página e, se continuar, avise o suporte.'
    );
  }
  if (status >= 500) {
    return `O backend da Loja Integrada falhou (HTTP ${String(status)}). Tente novamente em instantes.`;
  }
  return `Falha na comunicação com o backend da Loja Integrada (HTTP ${String(status)}).`;
}

/** What a body read may log: the text, or a marker when the request carried the token. */
function corpoParaLog(texto: string, levouToken: boolean): string {
  if (levouToken) {
    return `(corpo omitido: a requisição levava o token; ${String(texto.length)} caracteres)`;
  }
  return texto.length === 0 ? '(corpo vazio)' : texto.slice(0, 500);
}

function logarCorpoNaoJson(path: string, status: number, corpo: string): void {
  console.error(`[loja-integrada] resposta não-JSON em ${path} (HTTP ${String(status)})`, corpo);
}

/**
 * Read the body, turning a socket that drops MID-BODY into a network error: a
 * bare `TypeError` there would sail past every `instanceof` in the panel.
 */
async function lerCorpo(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    if (err instanceof TypeError) throw new LojaIntegradaClientNetworkError(err);
    throw err;
  }
}

/** A non-2xx body, read as the shared error envelope. */
function erroHttp(path: string, status: number, texto: string, levouToken: boolean): Error {
  const leitura = lerRespostaJson(texto, erroContaLojaIntegradaSchema);
  if (leitura.ok) {
    const env = leitura.data;
    return new LojaIntegradaClientHttpError(env.error, status, env.code, {
      campos: env.issues ?? [],
      statusLi: env.status ?? null,
      correlationId: env.correlationId ?? null,
    });
  }
  // Not our envelope: the request never reached a conta route that answers one.
  // The body stays on the console (unless the request carried the token) and
  // NEVER in `err.message` — a proxy's whole HTML page would bury the cause.
  if (leitura.motivo === 'nao-json') {
    logarCorpoNaoJson(path, status, corpoParaLog(leitura.texto, levouToken));
  }
  return new LojaIntegradaClientHttpError(mensagemHttpLojaIntegrada(status), status, null);
}

/** A 2xx body read against its schema, or the one error each failure earns. */
function lerCorpoJson<S extends z.ZodType>(
  path: string,
  status: number,
  texto: string,
  schema: S,
  levouToken: boolean,
): z.infer<S> {
  const leitura = lerRespostaJson(texto, schema);
  if (leitura.ok) return leitura.data;

  if (leitura.motivo !== 'formato') {
    // EMPTY and NON-JSON share this branch: neither is version skew — in both
    // the request failed to reach a route that answers JSON, so neither may
    // tell the operator to deploy anything.
    logarCorpoNaoJson(
      path,
      status,
      leitura.motivo === 'nao-json' ? corpoParaLog(leitura.texto, levouToken) : '(corpo vazio)',
    );
    throw new LojaIntegradaClientRespostaInvalidaError(
      `O backend da Loja Integrada respondeu HTTP ${String(status)} sem um corpo JSON — ` +
        'o pedido não chegou à rota esperada. Atualize a página e, se continuar, avise o suporte.',
      status,
      [],
    );
  }

  throw new LojaIntegradaClientRespostaInvalidaError(
    'O backend da Loja Integrada respondeu num formato que este aplicativo não reconhece. ' +
      `Campos inválidos: ${resumirCampos(leitura.campos)}. Normalmente isso significa que o ` +
      'backend e esta tela estão em versões diferentes — faça o deploy de `apps/loja-integrada` ' +
      'e recarregue a página.',
    status,
    leitura.campos,
  );
}

export function createLojaIntegradaClient(config: {
  baseUrl: string;
  getAuthToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): LojaIntegradaClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;

  /**
   * One JSON round trip.
   *
   * ⚠️ `getAuthToken()` stays OUTSIDE the try: a token failure is a
   * `FirebaseError`, not a transport failure, and relabelling it a network
   * error would send the operator to check a connection that is fine.
   */
  async function call<S extends z.ZodType>(
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
    schema: S,
    corpo?: Readonly<Record<string, unknown>>,
  ): Promise<z.infer<S>> {
    const idToken = await config.getAuthToken();
    const levouToken = corpo !== undefined && 'token' in corpo;
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${idToken}`,
          Accept: 'application/json',
          ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
      });
    } catch (err) {
      // `cause` keeps the transport's own error for a debugger; the message is
      // fixed (see the class).
      throw new LojaIntegradaClientNetworkError(err);
    }

    const texto = await lerCorpo(res);
    if (!res.ok) throw erroHttp(path, res.status, texto, levouToken);
    return lerCorpoJson(path, res.status, texto, schema, levouToken);
  }

  const caminhoDaConta = (integracaoId: string) =>
    `${CONTA_PATH}/${encodeURIComponent(integracaoId)}`;

  return {
    conta: (integracaoId) =>
      call('GET', caminhoDaConta(integracaoId), statusContaLojaIntegradaSchema),
    // Both bodies are rebuilt BY NAME: the routes' schemas are strict (an
    // unknown key is a 400), so a caller object carrying one more field must
    // not reach them.
    salvarCredencial: (integracaoId, corpo) =>
      call(
        'PUT',
        `${caminhoDaConta(integracaoId)}/credencial`,
        respostaCredencialLojaIntegradaSchema,
        { token: corpo.token, expiraEm: corpo.expiraEm, versaoEsperada: corpo.versaoEsperada },
      ),
    renovarValidade: (integracaoId, corpo) =>
      call(
        'PUT',
        `${caminhoDaConta(integracaoId)}/credencial/validade`,
        respostaCredencialLojaIntegradaSchema,
        { expiraEm: corpo.expiraEm, versaoEsperada: corpo.versaoEsperada },
      ),
    removerCredencial: (integracaoId) =>
      call(
        'DELETE',
        `${caminhoDaConta(integracaoId)}/credencial`,
        respostaRemocaoCredencialLiSchema,
      ),
  };
}

/** Why there is no client although someone is logged in. */
export type MotivoBackendLiIndisponivel =
  /** The page is `https:` and the backend URL is plain `http:` — the token would travel in clear. */
  | 'inseguro'
  /** `NEXT_PUBLIC_LOJA_INTEGRADA_URL` is not an `http(s)` URL at all. */
  | 'url-invalida';

export type BackendLojaIntegrada =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly motivo: MotivoBackendLiIndisponivel };

/**
 * Which backend URL this page may talk to, or why none.
 *
 * - an unset (or empty) variable falls back to {@link DEFAULT_LOJA_INTEGRADA_URL},
 *   like every channel client;
 * - an `https:` page and an `http:` backend is REFUSED (`inseguro`): the save
 *   carries a store's live token, and a production build missing the variable
 *   would otherwise post it to `http://localhost:3010` in clear;
 * - an `http:` page may talk to either (local dev, and CI's e2e build).
 *
 * Pure: the page protocol is a parameter, so the rule is testable without a
 * browser.
 */
export function resolverBackendLojaIntegrada(
  protocoloDaPagina: string,
  urlConfigurada: string | undefined,
): BackendLojaIntegrada {
  const baseUrl =
    urlConfigurada === undefined || urlConfigurada.trim() === ''
      ? DEFAULT_LOJA_INTEGRADA_URL
      : urlConfigurada.trim();
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (err) {
    // The WHATWG URL parser throws exactly a TypeError on an unparseable input.
    if (err instanceof TypeError) return { ok: false, motivo: 'url-invalida' };
    throw err;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, motivo: 'url-invalida' };
  }
  if (protocoloDaPagina === 'https:' && url.protocol === 'http:') {
    return { ok: false, motivo: 'inseguro' };
  }
  return { ok: true, baseUrl };
}

export interface EstadoBackendLojaIntegrada {
  /** The client, or `null` while logged out or when the backend is unusable. */
  readonly client: LojaIntegradaClient | null;
  /** Set only when someone IS logged in and still there is no client. */
  readonly indisponivel: MotivoBackendLiIndisponivel | null;
}

/**
 * The client plus the reason it is missing — what the panel renders from, so it
 * can tell "loading the session" (no reason) from "this build cannot talk to
 * the backend safely" (a reason, and a disabled form).
 *
 * `window` is read only once a user exists, which never happens during the
 * server render of this client component.
 */
export function useBackendLojaIntegrada(): EstadoBackendLojaIntegrada {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return { client: null, indisponivel: null };
    const backend = resolverBackendLojaIntegrada(
      window.location.protocol,
      process.env.NEXT_PUBLIC_LOJA_INTEGRADA_URL,
    );
    if (!backend.ok) return { client: null, indisponivel: backend.motivo };
    return {
      client: createLojaIntegradaClient({
        baseUrl: backend.baseUrl,
        getAuthToken: () => user.getIdToken(),
      }),
      indisponivel: null,
    };
  }, [user]);
}

/** {@link useBackendLojaIntegrada}'s client alone: `null` while logged out or when unusable. */
export function useLojaIntegradaClient(): LojaIntegradaClient | null {
  return useBackendLojaIntegrada().client;
}
