'use client';

/**
 * `useAmazonClient()` — a memoized typed client bound to the current Firebase
 * auth state, talking to the `apps/amazon` conta routes on their own App
 * Hosting backend. `null` while logged out (the `ConnectionPanel` contract: the
 * button is disabled), and `() => user.getIdToken()` so a refreshed ID token
 * propagates.
 *
 * Three calls, one per route (`apps/amazon/app/api/marketplace/amazon/…`):
 *
 * | call | route | answer |
 * | --- | --- | --- |
 * | `conta(id)` | `GET …/conta/[id]` | `statusContaAmazonSchema` |
 * | `oauthStart(id)` | `POST …/conta/[id]/oauth/start` | `respostaInicioOAuthAmazonSchema` |
 * | `etiqueta(pedidoId)` | `POST …/etiqueta` (step 15) | the Easy Ship label's ZPL bytes ({@link EtiquetaAmazon}) |
 *
 * Every JSON answer — the 2xx bodies AND the error envelopes — is read against
 * the ONE shared contract in `@delfrance/schemas` (`contaAmazon.ts`), the module
 * the routes build their answers with, through `lerRespostaJson`. Nothing here
 * is cast: a proxy's HTML page on a 2xx is an {@link AmazonRespostaInvalidaError},
 * never a truthy object whose `connected` reads `undefined`. The label's 200 is
 * BYTES, which no schema reaches, so `etiqueta` checks what can still go wrong
 * by hand (its own docblock).
 *
 * The conta calls carry no body: the conta id is the only input, percent-encoded
 * as the one path segment. Starting a consent is a POST because minting the
 * state is a WRITE on the backend, not because anything is sent. The label call
 * sends exactly `{ pedidoId }` (the route's body is strict).
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
 * ⚠️ This client retries NOTHING. A start mints a single-use state, the
 * status read's retry belongs to the operator (the panel's `RetryAlert`), and a
 * label call can be the call that schedules the pickup at Amazon.
 */
import { useMemo } from 'react';
import type { z } from 'zod';
import {
  type RespostaInicioOAuthAmazon,
  type StatusContaAmazon,
  erroContaAmazonSchema,
  erroEtiquetaAmazonSchema,
  respostaInicioOAuthAmazonSchema,
  statusContaAmazonSchema,
} from '@delfrance/schemas';
import { lerRespostaJson, resumirCampos } from '@delfrance/core/wire';

import { useAuth } from '@/lib/auth/useAuth';
import { filenameFromDisposition } from '@/lib/http/filenameFromDisposition';
import {
  AmazonBackendError,
  AmazonRedeError,
  AmazonRespostaInvalidaError,
  mensagemHttpAmazon,
  mensagemHttpEtiquetaAmazon,
} from './erros';

/** The local dev port of `apps/amazon` (`apps/amazon/package.json`). */
export const DEFAULT_AMAZON_URL = 'http://localhost:3011';

/** Every conta route hangs off this prefix (`apps/amazon/proxy.ts` covers `/api/marketplace/*`). */
const CONTA_PATH = '/api/marketplace/amazon/conta';

/** The Easy Ship label route (step 15, PR 15-d), under the same proxy matcher. */
export const ETIQUETA_AMAZON_PATH = '/api/marketplace/amazon/etiqueta';

/**
 * The label's name when the browser cannot read the route's
 * `Content-Disposition` (a backend whose proxy does not expose it).
 */
export const NOME_ETIQUETA_AMAZON_PADRAO = 'amazon-etiqueta.zpl';

/** The ONE type the label route answers its label with: the ZPL as plain text. */
export const TIPO_ETIQUETA_AMAZON = 'text/plain';

/** One Easy Ship label, as the label route answered it. */
export interface EtiquetaAmazon {
  /** The route's bytes, untouched — never decoded to text and back. */
  readonly bytes: Blob;
  /** The route's file name (`amazon-<orderId>.zpl`), else {@link NOME_ETIQUETA_AMAZON_PADRAO}. */
  readonly nomeArquivo: string;
  /**
   * The answer's `Content-Type` AS RECEIVED, a parameter a proxy appended
   * included. Its essence is always {@link TIPO_ETIQUETA_AMAZON} (anything else
   * is refused); it is for a log or a check, never for a consumer that compares
   * it with `==`.
   */
  readonly tipo: string;
}

/** The slice of the backend this app calls — `ConnectionPanel`'s `OAuthContaClient`, plus the label. */
export interface AmazonClient {
  /** The conta's connection status (`PERM.integracao.read`). Never a token or a seller id. */
  conta(contaId: string): Promise<StatusContaAmazon>;
  /**
   * Mint the single-use state and get the Seller Central consent URL
   * (`PERM.integracao.write`). The caller navigates to it.
   */
  oauthStart(contaId: string): Promise<RespostaInicioOAuthAmazon>;
  /**
   * The Easy Ship label of ONE pedido (`PERM.frete.read`; a first schedule also
   * needs `PERM.frete.write`), by the ERP pedido DOCUMENT id. The route asks
   * Amazon inside the request: for an order not scheduled yet the same call
   * schedules the pickup. `signal` aborts it; once it aborted, the call rejects
   * with what the transport rejected with (normally the abort itself), never
   * relabelled a network error.
   */
  etiqueta(pedidoId: string, opts?: { readonly signal?: AbortSignal }): Promise<EtiquetaAmazon>;
}

function logarCorpoNaoJson(path: string, status: number, corpo: string): void {
  console.error(`[amazon] resposta não-JSON em ${path} (HTTP ${String(status)})`, corpo);
}

/** What a log line may carry of a body that was not JSON: its head, or a marker. */
function corpoParaLog(texto: string): string {
  return texto.length === 0 ? '(corpo vazio)' : texto.slice(0, 500);
}

/**
 * Read a response BODY, turning a socket that drops MID-BODY into a network
 * error: a bare `TypeError` there would sail past every `instanceof` in the
 * panel and in the label provider.
 *
 * ⚠️ Wrapping only `fetch` is not enough: the headers can arrive and the socket
 * still drop while the body streams, and `text()` / `blob()` then reject with a
 * bare `TypeError`.
 *
 * Once the CALLER's signal aborted, whatever the read rejects with rethrows
 * untouched (normally the abort itself): the caller tells its own deadline
 * apart from a transport failure by that signal. Any error that is not a
 * `TypeError` is not a transport failure and rethrows too.
 */
async function lerCorpo<T>(ler: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await ler();
  } catch (err) {
    if (signal?.aborted === true) throw err;
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

/**
 * A non-2xx body of the LABEL route, read as ITS envelope
 * (`erroEtiquetaAmazonSchema`): the conta routes' envelope plus `motivo`, which
 * `erroContaAmazonSchema` would strip. A body that is not the envelope gets the
 * label call's own status sentence, never the conta routes'.
 */
function erroHttpEtiqueta(status: number, texto: string): AmazonBackendError {
  const leitura = lerRespostaJson(texto, erroEtiquetaAmazonSchema);
  if (leitura.ok) {
    const env = leitura.data;
    return new AmazonBackendError(
      env.error,
      status,
      env.code,
      env.issues ?? [],
      env.motivo ?? null,
    );
  }
  if (leitura.motivo === 'nao-json') {
    logarCorpoNaoJson(ETIQUETA_AMAZON_PATH, status, corpoParaLog(leitura.texto));
  }
  return new AmazonBackendError(mensagemHttpEtiquetaAmazon(status), status, null);
}

/** A `Content-Type`'s MIME essence — lower-cased, parameters dropped. */
function essenciaDoTipo(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Whether a `Content-Type` is the label route's label: its ESSENCE exactly
 * {@link TIPO_ETIQUETA_AMAZON}, so `text/plain; charset=utf-8` (a parameter a
 * proxy may append) passes and `text/plainx`, `text/html` or an absent header
 * do not.
 */
export function ehTipoEtiquetaAmazon(contentType: string | null): contentType is string {
  return contentType !== null && essenciaDoTipo(contentType) === TIPO_ETIQUETA_AMAZON;
}

/** How many leading bytes the markup sniff reads. */
const CABECA_DO_SNIFF_BYTES = 512;

/** Space, tab, line feed and carriage return: what may precede a ZPL's first command. */
const BRANCOS: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** `<` (an HTML page) and `{` (a JSON body): never the first byte of a label. */
const INICIOS_DE_MARCACAO: ReadonlySet<number> = new Set([0x3c, 0x7b]);

/** The first byte of `bytes` that is not blank, or `null` when its head is empty or all blank. */
async function primeiroByteVisivel(bytes: Blob): Promise<number | null> {
  const cabeca = new Uint8Array(await bytes.slice(0, CABECA_DO_SNIFF_BYTES).arrayBuffer());
  for (const byte of cabeca) if (!BRANCOS.has(byte)) return byte;
  return null;
}

/** The sentence of a 200 the label call refuses: what happened, and the way out. */
function etiquetaRecusada(status: number, oQue: string): AmazonRespostaInvalidaError {
  return new AmazonRespostaInvalidaError(
    `O backend da Amazon respondeu HTTP ${String(status)} ${oQue} — o pedido não chegou à rota ` +
      'esperada, ou o backend e esta tela estão em versões diferentes. Imprima a etiqueta pela ' +
      'Seller Central e avise o suporte.',
    status,
    [],
  );
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
    const texto = await lerCorpo(() => res.text());
    if (!res.ok) throw erroHttp(path, res.status, texto);
    return { status: res.status, corpo: lerCorpoJson(path, res.status, texto, schema) };
  }

  /**
   * The label call: 200 = the label's bytes; anything else fails.
   *
   * ⚠️ The 200 is the one success path a schema cannot reach — the body is
   * bytes — so what can still go wrong is checked by hand, and each check
   * throws {@link AmazonRespostaInvalidaError}, NEVER a `Blob` a printer would
   * be fed: a 2xx other than 200; a type whose essence is not
   * {@link TIPO_ETIQUETA_AMAZON} (a proxy's HTML, a JSON body); an empty or
   * blank body; a body whose first visible byte is `<` or `{` (markup served
   * as text). The bytes are read with `blob()`, never `text()`: a decode and
   * re-encode would rewrite every byte that is not valid UTF-8.
   *
   * Nothing of a refused 200's BODY is logged: a refused type logs its essence,
   * a markup body its byte count, never a byte of it (a label's text carries a
   * buyer's name and address).
   *
   * Once the caller's `signal` aborted, the call rejects with what the transport
   * rejected with — normally the abort ITSELF — in flight and during the body
   * read alike; any other transport failure is {@link AmazonRedeError}; a
   * non-2xx is {@link AmazonBackendError} carrying the envelope's `motivo`.
   */
  async function etiqueta(
    pedidoId: string,
    opts: { readonly signal?: AbortSignal } = {},
  ): Promise<EtiquetaAmazon> {
    const { signal } = opts;
    const idToken = await obterIdToken();
    let res: Response;
    try {
      res = await fetchImpl(`${base}${ETIQUETA_AMAZON_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pedidoId }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (err) {
      if (signal?.aborted === true) throw err;
      throw new AmazonRedeError(err);
    }

    if (!res.ok) throw erroHttpEtiqueta(res.status, await lerCorpo(() => res.text(), signal));
    if (res.status !== 200) throw etiquetaRecusada(res.status, 'em vez da etiqueta');

    const tipo = res.headers.get('content-type');
    if (!ehTipoEtiquetaAmazon(tipo)) {
      const recebido = tipo === null ? 'ausente' : essenciaDoTipo(tipo).slice(0, 80);
      console.error(`[amazon] etiqueta com tipo recusado em ${ETIQUETA_AMAZON_PATH}`, recebido);
      throw etiquetaRecusada(res.status, `sem uma etiqueta ZPL (tipo ${recebido})`);
    }

    const bytes = await lerCorpo(() => res.blob(), signal);
    // An empty body has no visible byte either: one check refuses both.
    const primeiro = await primeiroByteVisivel(bytes);
    if (primeiro === null) {
      throw etiquetaRecusada(res.status, 'sem a etiqueta (corpo vazio ou em branco)');
    }
    if (INICIOS_DE_MARCACAO.has(primeiro)) {
      console.error(`[amazon] etiqueta com marcação em ${ETIQUETA_AMAZON_PATH}`, bytes.size);
      throw etiquetaRecusada(res.status, 'com uma página ou um JSON em vez da etiqueta ZPL');
    }

    return {
      bytes,
      nomeArquivo:
        filenameFromDisposition(res.headers.get('content-disposition')) ??
        NOME_ETIQUETA_AMAZON_PADRAO,
      tipo,
    };
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
    etiqueta,
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
