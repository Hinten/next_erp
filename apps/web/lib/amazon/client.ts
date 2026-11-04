'use client';

/**
 * `useAmazonClient()` — a memoized typed client bound to the current Firebase
 * auth state, talking to the `apps/amazon` conta routes on their own App
 * Hosting backend. `null` while logged out (the `ConnectionPanel` contract: the
 * button is disabled), and `() => user.getIdToken()` so a refreshed ID token
 * propagates.
 *
 * Two calls, one per route (`apps/amazon/app/api/marketplace/amazon/conta/[id]/…`):
 *
 * | call | route | answer |
 * | --- | --- | --- |
 * | `conta(id)` | `GET …/conta/[id]` | `statusContaAmazonSchema` |
 * | `oauthStart(id)` | `POST …/conta/[id]/oauth/start` | `respostaInicioOAuthAmazonSchema` |
 *
 * Every answer — the 2xx bodies AND the error envelope — is read against the ONE
 * shared contract in `@delfrance/schemas` (`contaAmazon.ts`), the module the
 * routes build their answers with, through `lerRespostaJson`. Nothing here is
 * cast: a proxy's HTML page on a 2xx is an {@link AmazonRespostaInvalidaError},
 * never a truthy object whose `connected` reads `undefined`.
 *
 * No request carries a body: the conta id is the only input, percent-encoded
 * as the one path segment. Starting a consent is a POST because minting the
 * state is a WRITE on the backend, not because anything is sent.
 *
 * ## Fail closed: an `https:` page never sends to an `http:` backend
 *
 * Every channel client falls back to its `localhost` port when its
 * `NEXT_PUBLIC_*_URL` is missing from a build. Here every call carries the
 * operator's Firebase ID token in the `Authorization` header, so a production
 * build missing the variable would send it to `http://localhost:3011` in clear;
 * {@link resolverBackendAmazon} refuses that combination and the panel says the
 * backend is not configured. It deliberately keys on the PAGE's protocol rather
 * than on `NODE_ENV`: CI's e2e serves a production build over plain http with
 * no `NEXT_PUBLIC_*_URL` set, and its stubbed-backend cases must keep working.
 *
 * ⚠️ This client retries NOTHING. A start mints a single-use state, and the
 * status read's retry belongs to the operator (the panel's `RetryAlert`).
 */
import { useMemo } from 'react';
import type { z } from 'zod';
import {
  type RespostaInicioOAuthAmazon,
  type StatusContaAmazon,
  erroContaAmazonSchema,
  respostaInicioOAuthAmazonSchema,
  statusContaAmazonSchema,
} from '@delfrance/schemas';
import { lerRespostaJson, resumirCampos } from '@delfrance/core/wire';

import { useAuth } from '@/lib/auth/useAuth';
import {
  AmazonBackendError,
  AmazonRedeError,
  AmazonRespostaInvalidaError,
  mensagemHttpAmazon,
} from './erros';

/** The local dev port of `apps/amazon` (`apps/amazon/package.json`). */
export const DEFAULT_AMAZON_URL = 'http://localhost:3011';

/** Every conta route hangs off this prefix (`apps/amazon/proxy.ts` covers `/api/marketplace/*`). */
const CONTA_PATH = '/api/marketplace/amazon/conta';

/** The slice of the backend this app calls — `ConnectionPanel`'s `OAuthContaClient`. */
export interface AmazonClient {
  /** The conta's connection status (`PERM.integracao.read`). Never a token or a seller id. */
  conta(contaId: string): Promise<StatusContaAmazon>;
  /**
   * Mint the single-use state and get the Seller Central consent URL
   * (`PERM.integracao.write`). The caller navigates to it.
   */
  oauthStart(contaId: string): Promise<RespostaInicioOAuthAmazon>;
}

function logarCorpoNaoJson(path: string, status: number, corpo: string): void {
  console.error(`[amazon] resposta não-JSON em ${path} (HTTP ${String(status)})`, corpo);
}

/** What a log line may carry of a body that was not JSON: its head, or a marker. */
function corpoParaLog(texto: string): string {
  return texto.length === 0 ? '(corpo vazio)' : texto.slice(0, 500);
}

/**
 * Read the body, turning a socket that drops MID-BODY into a network error: a
 * bare `TypeError` there would sail past every `instanceof` in the panel.
 */
async function lerCorpo(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    if (err instanceof TypeError) throw new AmazonRedeError(err);
    throw err;
  }
}

/** A non-2xx body, read as the shared error envelope. */
function erroHttp(path: string, status: number, texto: string): AmazonBackendError {
  const leitura = lerRespostaJson(texto, erroContaAmazonSchema);
  if (leitura.ok) {
    const env = leitura.data;
    return new AmazonBackendError(env.error, status, env.code, env.issues ?? []);
  }
  // Not our envelope: `verifyCaller`'s codeless 401/403 (`{ error }` only), or a
  // request that never reached a conta route (a proxy page, a platform
  // timeout). A non-JSON body stays on the console and NEVER in `err.message`.
  if (leitura.motivo === 'nao-json') logarCorpoNaoJson(path, status, corpoParaLog(leitura.texto));
  return new AmazonBackendError(mensagemHttpAmazon(status), status, null);
}

/** A 2xx body read against its schema, or the one error each failure earns. */
function lerCorpoJson<S extends z.ZodType>(
  path: string,
  status: number,
  texto: string,
  schema: S,
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
      leitura.motivo === 'nao-json' ? corpoParaLog(leitura.texto) : '(corpo vazio)',
    );
    throw new AmazonRespostaInvalidaError(
      `O backend da Amazon respondeu HTTP ${String(status)} sem um corpo JSON — o pedido não ` +
        'chegou à rota esperada. Atualize a página e, se continuar, avise o suporte.',
      status,
      [],
    );
  }

  throw new AmazonRespostaInvalidaError(
    'O backend da Amazon respondeu num formato que este aplicativo não reconhece. Campos ' +
      `inválidos: ${resumirCampos(leitura.campos)}. Normalmente isso significa que o backend e ` +
      'esta tela estão em versões diferentes — faça o deploy de `apps/amazon` e recarregue a página.',
    status,
    leitura.campos,
  );
}

/** The schemes a consent URL may use. Anything else (`javascript:`, `data:`) is never navigated to. */
const PROTOCOLOS_DE_CONSENTIMENTO: ReadonlySet<string> = new Set(['https:', 'http:']);

/** A URL's scheme (`'https:'`), or `''` when the WHATWG parser refuses it. */
function protocoloDe(url: string): string {
  try {
    return new URL(url).protocol;
  } catch (err) {
    // The WHATWG URL parser throws exactly a TypeError on an unparseable input.
    if (err instanceof TypeError) return '';
    throw err;
  }
}

/**
 * The start answer, one step past the schema: `z.string().url()` admits any
 * scheme a WHATWG parser accepts, `javascript:` included, and the panel hands
 * this string straight to `window.location.assign`. The consent URL is always
 * an `https:` Seller Central page; `http:` stays allowed for a stubbed local
 * path (the e2e). A schema-valid answer with another scheme is a 2xx this app
 * refuses to act on — the same class as a wrong shape.
 */
function exigirUrlNavegavel(
  path: string,
  status: number,
  resposta: RespostaInicioOAuthAmazon,
): RespostaInicioOAuthAmazon {
  if (PROTOCOLOS_DE_CONSENTIMENTO.has(protocoloDe(resposta.authorizeUrl))) return resposta;
  console.error(`[amazon] authorizeUrl com esquema recusado em ${path}`);
  throw new AmazonRespostaInvalidaError(
    'O backend da Amazon devolveu um endereço de consentimento que não é http(s); a navegação ' +
      'foi recusada. Avise o suporte.',
    status,
    ['authorizeUrl'],
  );
}

/**
 * The client for the `apps/amazon` conta routes.
 *
 * @param baseUrl the backend's origin (a trailing `/` is dropped).
 * @param obterIdToken the operator's Firebase ID token, read per call.
 * @param fetchImpl the transport; the global `fetch` unless a test injects one.
 */
export function criarClienteAmazon(
  baseUrl: string,
  obterIdToken: () => Promise<string>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): AmazonClient {
  const base = baseUrl.replace(/\/$/, '');

  /**
   * One JSON round trip.
   *
   * ⚠️ `obterIdToken()` stays OUTSIDE the try: a token failure is a
   * `FirebaseError`, not a transport failure, and relabelling it a network
   * error would send the operator to check a connection that is fine.
   */
  async function chamar(method: 'GET' | 'POST', path: string): Promise<Response> {
    const idToken = await obterIdToken();
    try {
      return await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${idToken}`, Accept: 'application/json' },
      });
    } catch (err) {
      // `cause` keeps the transport's own error for a debugger; the message is
      // fixed (see the class).
      throw new AmazonRedeError(err);
    }
  }

  async function ler<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
  ): Promise<{ readonly status: number; readonly corpo: z.infer<S> }> {
    const res = await chamar(method, path);
    const texto = await lerCorpo(res);
    if (!res.ok) throw erroHttp(path, res.status, texto);
    return { status: res.status, corpo: lerCorpoJson(path, res.status, texto, schema) };
  }

  const caminhoDaConta = (contaId: string) => `${CONTA_PATH}/${encodeURIComponent(contaId)}`;

  return {
    conta: async (contaId) =>
      (await ler('GET', caminhoDaConta(contaId), statusContaAmazonSchema)).corpo,
    oauthStart: async (contaId) => {
      const path = `${caminhoDaConta(contaId)}/oauth/start`;
      const { status, corpo } = await ler('POST', path, respostaInicioOAuthAmazonSchema);
      return exigirUrlNavegavel(path, status, corpo);
    },
  };
}

/** Why there is no client although someone is logged in. */
export type MotivoBackendAmazonIndisponivel =
  /** The page is `https:` and the backend URL is plain `http:` — the ID token would travel in clear. */
  | 'inseguro'
  /** `NEXT_PUBLIC_AMAZON_URL` is not an `http(s)` URL at all. */
  | 'url-invalida';

export type BackendAmazon =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly motivo: MotivoBackendAmazonIndisponivel };

/**
 * Which backend URL this page may talk to, or why none.
 *
 * - an unset (or blank) variable falls back to {@link DEFAULT_AMAZON_URL}, like
 *   every channel client;
 * - an `https:` page and an `http:` backend is REFUSED (`inseguro`);
 * - an `http:` page may talk to either (local dev, and CI's e2e build).
 *
 * Pure: the page protocol is a parameter, so the rule is testable without a
 * browser.
 */
export function resolverBackendAmazon(
  protocoloDaPagina: string,
  urlConfigurada: string | undefined,
): BackendAmazon {
  const baseUrl =
    urlConfigurada === undefined || urlConfigurada.trim() === ''
      ? DEFAULT_AMAZON_URL
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

export interface EstadoBackendAmazon {
  /** The client, or `null` while logged out or when the backend is unusable. */
  readonly client: AmazonClient | null;
  /** Set only when someone IS logged in and still there is no client. */
  readonly indisponivel: MotivoBackendAmazonIndisponivel | null;
}

/**
 * The client plus the reason it is missing — what the panel renders from, so it
 * can tell "still signing in" (no reason) from "this build cannot talk to the
 * backend safely" (a reason, and an Alert).
 *
 * `window` is read only once a user exists, which never happens during the
 * server render of this client component.
 */
export function useBackendAmazon(): EstadoBackendAmazon {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return { client: null, indisponivel: null };
    const backend = resolverBackendAmazon(
      window.location.protocol,
      process.env.NEXT_PUBLIC_AMAZON_URL,
    );
    if (!backend.ok) return { client: null, indisponivel: backend.motivo };
    return {
      client: criarClienteAmazon(backend.baseUrl, () => user.getIdToken()),
      indisponivel: null,
    };
  }, [user]);
}

/** {@link useBackendAmazon}'s client alone: `null` while logged out or when unusable. */
export function useAmazonClient(): AmazonClient | null {
  return useBackendAmazon().client;
}
