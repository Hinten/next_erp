/**
 * The Loja Integrada transport: one GET-only client, `criarClienteLeituraLi`.
 *
 * ## There is no write method, by construction
 *
 * The client exposes `get` and nothing else, and `get` takes no body. Every
 * request this package can make is a `GET` — there is no flag to flip, no verb
 * parameter, no request body to fill. Nothing writes to Loja Integrada before
 * the cutover; the first write step adds its own, separately reviewed method.
 *
 * ## The credential
 *
 * Loja Integrada's Personal Token travels as `Authorization: Basic <token>`, the
 * token RAW after `Basic ` — not base64-encoded, not `Bearer`, never in the URL.
 *
 * - `obterCredencial()` is called on EVERY request and its result is never kept,
 *   so a reconnected conta takes effect on the next call and the token lives in
 *   this module only for the duration of one request.
 * - ⚠️ **The token must be visible ASCII (`\x21-\x7E`), checked before any header
 *   is built.** Node's `fetch` rejects a header value carrying a control
 *   character (U+0000) with a `TypeError` whose message QUOTES the whole
 *   `Authorization` value — which this module would otherwise have turned into a
 *   `LiNetworkError` with the token in its `cause`. And a non-ASCII or
 *   whitespace character is never part of a real token: it is a paste accident
 *   (a trailing line break), refused with `LiConfigError('token')` and never
 *   sent. The token is never trimmed here — whether a form strips surrounding
 *   whitespace is the form's decision.
 * - `ref` is an opaque, non-secret label for the credential (a fingerprint the
 *   app computes). It is echoed on the response, on every error and on every
 *   observer event, so the app can tell WHICH credential a 401 belonged to —
 *   except on the error that refuses the token or the `ref` itself.
 * - The token is never in the URL, and that is CHECKED, not assumed: a path or a
 *   query key or value carrying it is refused with `LiConfigError('token-na-url')`
 *   before the URL exists. Every error message and observer event names the path
 *   and the query, so a token interpolated into either would otherwise reach all
 *   of them.
 *
 * ## Each request, in order
 *
 *  1. Validate the path (`/v1/…`, no `?`, `#`, `://`, `..` or an encoded `.`,
 *     `/` or `\`, and unchanged by the URL parser).
 *  2. `await obterCredencial()` — OUTSIDE the deadline, so a slow getter does not
 *     eat the call's budget — then validate the token and the `ref`, and refuse
 *     a URL that carries the token.
 *  3. Generate the correlation id (even when the header is off, so the app's
 *     logs still correlate).
 *  4. Build exactly `Authorization`, `Accept` and, when enabled,
 *     `x-correlation-id`. No `Content-Type` on a GET.
 *  5. Open the deadline, `fetch` with `redirect: 'manual'`, read the body INSIDE
 *     the window, release the deadline in `finally`.
 *  6. Classify the outcome into the `errors.ts` taxonomy.
 *  7. Call `onChamada` once, then return or throw.
 *
 * ⚠️ **Redirects are never followed.** A 3xx is a `LiHttpError`. Following one
 * would double the calls silently and could carry the `Authorization` header to
 * a target nobody chose.
 */
import { abrirPrazo, lerRespostaJson } from '@delfrance/core/wire';
import type { z } from 'zod';

import {
  type CodigoLimiteLi,
  type ContextoRequisicaoLi,
  extrairEscopoLimite,
  lerRetryAfter,
  LiAuthError,
  LiConfigError,
  LiHttpError,
  LiNetworkError,
  LiNotFoundError,
  LiSchemaError,
  LiThrottleError,
  LiTimeoutError,
} from './errors';
import { PRAZO_LI_MS } from './prazos';

/**
 * The one origin this package talks to. A constant, not an option: Loja
 * Integrada has no sandbox, and a fixed origin rules out a whole class of
 * misconfiguration — including a response-supplied host (`paginacao.ts`).
 */
export const URL_BASE_LI = 'https://api.awsli.com.br';

/** What replaces the token in the body text handed to the observer. */
export const TOKEN_REMOVIDO = '[token removido]';

/** The longest `ref` accepted; a label, not a payload. */
export const MAX_REF_CREDENCIAL = 64;

/** Visible ASCII only: no space, tab, line break, control character or non-ASCII. */
const TOKEN_VALIDO = /^[\x21-\x7E]+$/;

const PREFIXO_CAMINHO = /^\/v1\//;

/**
 * A percent-encoded `.`, `/` or `\`. None of the three ever NEEDS encoding in a
 * path, so the encoded form has no use but to slip a parent segment or a
 * separator past a literal check (a server that decodes `%2e%2e%5c` may still
 * walk up).
 */
const SEPARADOR_CODIFICADO = /%(?:2e|2f|5c)/i;

/** The credential for ONE request. */
export interface CredencialLi {
  /** The Personal Token, raw. */
  readonly token: string;
  /** An opaque, non-secret label for this credential (see the module header). */
  readonly ref: string;
}

/** How a request ended, as the observer sees it. */
export type ResultadoChamadaLi =
  | 'ok'
  | 'http'
  | 'auth'
  | 'nao-encontrado'
  | 'limite'
  | 'schema'
  | 'rede'
  | 'tempo-esgotado'
  /** The caller's own `sinal` aborted the request; its reason was rethrown as-is. */
  | 'cancelado'
  /** The transport rejected with something unclassified, rethrown as-is. */
  | 'inesperado';

/**
 * One request, as the observer sees it.
 *
 * ⚠️ Built from named fields, never by spreading the request: it never contains
 * the token, a request header or `Authorization`. `corpo` is the full response
 * text with the token scrubbed out; the app's logger applies its own allow-list
 * and size cap. The event exists only in memory.
 */
export interface ChamadaLi {
  readonly operacao: string;
  readonly metodo: 'GET';
  /** The path, without the query. */
  readonly caminho: string;
  /** The query entries as sent, raw — the logger's allow-list redacts them. */
  readonly query: readonly (readonly [string, string])[];
  readonly correlationId: string;
  readonly enviouCorrelationId: boolean;
  readonly refCredencial: string;
  /** `null` when there was no response at all. */
  readonly status: number | null;
  readonly latenciaMs: number;
  readonly resultado: ResultadoChamadaLi;
  /** On a 429 only: the single limit code the body named, else `null`. */
  readonly codigoLimite: CodigoLimiteLi | null;
  readonly retryAfterS: number | null;
  /** The response text, token scrubbed; `null` when no body was read. */
  readonly corpo: string | null;
}

export interface OpcoesClienteLi {
  /**
   * Called on EVERY request; the result is never stored. A getter that throws
   * propagates as itself and no request is made.
   */
  readonly obterCredencial: () => CredencialLi | Promise<CredencialLi>;
  /** Defaults to `globalThis.fetch`, resolved at call time. */
  readonly fetch?: typeof globalThis.fetch;
  /** Defaults to `crypto.randomUUID()`. */
  readonly gerarCorrelationId?: () => string;
  /** Send `x-correlation-id`. Defaults to `true`. */
  readonly enviarCorrelationId?: boolean;
  /**
   * Called once per request that was sent, synchronously, after the outcome is
   * known and before the call returns or throws. Not called when nothing was
   * sent (`LiConfigError`, a getter that threw, a `sinal` already aborted).
   *
   * ⚠️ An observer that throws propagates in place of the outcome. Harmless for
   * a GET; a logger must still never throw.
   */
  readonly onChamada?: (e: ChamadaLi) => void;
  /** Milliseconds, for `latenciaMs` only. Defaults to `Date.now`. */
  readonly agora?: () => number;
}

export interface PedidoGetLi<S extends z.ZodType> {
  /** The caller's label for the call; it names the call in messages and events. */
  readonly operacao: string;
  /** A path under `/v1/`, without a query (the query goes in `query`). */
  readonly caminho: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly schema: S;
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
}

export interface RespostaLi<T> {
  readonly dados: T;
  readonly status: number;
  readonly correlationId: string;
  /** The `ref` of the credential THIS request used. */
  readonly refCredencial: string;
}

/** The read-only client. There is no other method, and no body parameter. */
export interface LiLeituraClient {
  get<S extends z.ZodType>(p: PedidoGetLi<S>): Promise<RespostaLi<z.infer<S>>>;
}

/**
 * A path under `/v1/` that reaches the server exactly as written.
 *
 * ⚠️ The literal checks alone are not enough. The WHATWG parser `fetch` uses
 * reads `%2e%2e` and `.%2E` as a parent segment, strips a tab or a line break
 * (so `.<tab>.` becomes `..`), and treats `\` as `/`. So the path must ALSO come
 * out of that parser unchanged, on our origin, with no query and no fragment —
 * whatever the parser would have rewritten, it refuses instead.
 */
function caminhoValido(caminho: unknown): caminho is string {
  if (
    typeof caminho !== 'string' ||
    !PREFIXO_CAMINHO.test(caminho) ||
    caminho.includes('?') ||
    caminho.includes('#') ||
    caminho.includes('://') ||
    caminho.includes('..') ||
    SEPARADOR_CODIFICADO.test(caminho)
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(`${URL_BASE_LI}${caminho}`);
  } catch (err) {
    if (err instanceof TypeError) return false;
    throw err;
  }
  return (
    url.origin === URL_BASE_LI && url.pathname === caminho && url.search === '' && url.hash === ''
  );
}

function tokenValido(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_VALIDO.test(token);
}

function refValida(ref: unknown, token: unknown): ref is string {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_REF_CREDENCIAL) return false;
  // An empty token is refused on its own account; `''` is inside every string.
  return !(typeof token === 'string' && token.length > 0 && ref.includes(token));
}

/**
 * Refuse an unusable credential before anything is built from it.
 *
 * ⚠️ **A refused token never carries its `ref`.** `refValida` can only spot the
 * token VERBATIM inside the `ref`, and a malformed token is by definition not
 * the string the app meant: a `ref` holding the clean token does not contain
 * the dirty one (`TOKEN` vs `TOKEN\n`), and would ride the error whole. The app
 * knows which credential its own getter returned.
 */
function validarCredencial(credencial: CredencialLi, operacao: string): void {
  const { token, ref } = credencial;
  if (!tokenValido(token)) throw new LiConfigError('token', { operacao, refCredencial: null });
  if (!refValida(ref, token)) throw new LiConfigError('ref', { operacao, refCredencial: null });
}

/**
 * Whether the token appears in the URL about to be built: in the path, in a
 * query key or value as given, or in the final URL (a token can also be
 * assembled across `key=value`).
 */
function tokenNaUrl(
  token: string,
  url: string,
  query: readonly (readonly [string, string])[],
): boolean {
  return url.includes(token) || query.some(([k, v]) => k.includes(token) || v.includes(token));
}

export function criarClienteLeituraLi(opts: OpcoesClienteLi): LiLeituraClient {
  // Resolved at call time, and never called unbound: some runtimes reject a
  // detached `fetch` ("Illegal invocation").
  const fetchImpl: typeof globalThis.fetch =
    opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const gerarCorrelationId = opts.gerarCorrelationId ?? (() => globalThis.crypto.randomUUID());
  const enviarCorrelationId = opts.enviarCorrelationId ?? true;
  const agora = opts.agora ?? (() => Date.now());

  async function get<S extends z.ZodType>(p: PedidoGetLi<S>): Promise<RespostaLi<z.infer<S>>> {
    const { operacao, caminho, schema, sinal } = p;

    // 1. The path. Its message never echoes it: a malformed one may carry a query.
    if (!caminhoValido(caminho)) {
      throw new LiConfigError('caminho', { operacao, refCredencial: null });
    }

    // 2. The credential, OUTSIDE the deadline, every time.
    const credencial = await opts.obterCredencial();
    validarCredencial(credencial, operacao);
    const { token, ref } = credencial;

    const query: readonly (readonly [string, string])[] = Object.entries(p.query ?? {}).map(
      ([k, v]) => [k, String(v)] as const,
    );
    const qs = new URLSearchParams(query.map(([k, v]) => [k, v])).toString();
    const url = `${URL_BASE_LI}${caminho}${qs === '' ? '' : `?${qs}`}`;

    // The token travels in `Authorization` only. Refused here, before any
    // message or event is built from the path and the query.
    if (tokenNaUrl(token, url, query)) {
      throw new LiConfigError('token-na-url', { operacao, refCredencial: ref });
    }

    // 3. The correlation id.
    const correlationId = gerarCorrelationId();

    // 4. Exactly these headers.
    const headers: Record<string, string> = {
      Authorization: `Basic ${token}`,
      Accept: 'application/json',
    };
    if (enviarCorrelationId) headers['x-correlation-id'] = correlationId;

    const ctx: ContextoRequisicaoLi = { operacao, caminho, correlationId, refCredencial: ref };
    const emitir = (
      e: Pick<ChamadaLi, 'resultado' | 'status' | 'latenciaMs' | 'corpo'> &
        Partial<Pick<ChamadaLi, 'codigoLimite' | 'retryAfterS'>>,
    ): void => {
      opts.onChamada?.({
        operacao,
        metodo: 'GET',
        caminho,
        query,
        correlationId,
        enviouCorrelationId: enviarCorrelationId,
        refCredencial: ref,
        status: e.status,
        latenciaMs: e.latenciaMs,
        resultado: e.resultado,
        codigoLimite: e.codigoLimite ?? null,
        retryAfterS: e.retryAfterS ?? null,
        corpo: e.corpo,
      });
    };

    // Nothing was sent yet: a caller that already gave up gets its own abort back.
    sinal?.throwIfAborted();

    // 5. The deadline. The body read is INSIDE it: a server that sends its
    // headers and then stalls would otherwise hang past the budget.
    const prazoMs = PRAZO_LI_MS.leitura;
    const inicio = agora();
    const prazo = abrirPrazo(prazoMs, { vincular: sinal });
    let res: Response | undefined;
    let texto: string;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: prazo.signal,
      });
      texto = await res.text();
    } catch (err) {
      const falha = {
        status: res?.status ?? null,
        latenciaMs: agora() - inicio,
        corpo: null,
      };
      // Asked of the deadline itself, never `err instanceof DOMException`:
      // `fetch` rejects with the signal's reason as-is (`prazo.ts`).
      if (prazo.esgotado()) {
        emitir({ ...falha, resultado: 'tempo-esgotado' });
        throw new LiTimeoutError({ ...ctx, prazoMs }, err);
      }
      // The caller's own cancel is theirs: rethrown as itself, never wrapped.
      if (sinal?.aborted === true) {
        emitir({ ...falha, resultado: 'cancelado' });
        throw err;
      }
      // Both the fetch and a connection dropped MID-BODY reject with a
      // `TypeError` ("terminated" in Node). The token check above guarantees
      // this one cannot quote the token.
      if (err instanceof TypeError) {
        emitir({ ...falha, resultado: 'rede' });
        throw new LiNetworkError(ctx, err);
      }
      emitir({ ...falha, resultado: 'inesperado' });
      throw err;
    } finally {
      // Always: the timer is not `unref`'d, so a forgotten one holds the event
      // loop for the whole window.
      prazo.liberar();
    }

    // 6. Classify. The scrubbed text is for the observer ONLY; the parse reads
    // the raw text, so a scrub can never alter the data.
    const status = res.status;
    const latenciaMs = agora() - inicio;
    const corpo = texto.replaceAll(token, TOKEN_REMOVIDO);
    const retryAfterS = lerRetryAfter(res.headers.get('retry-after'));
    const base = { status, latenciaMs, corpo, retryAfterS };

    if (res.ok) {
      const leitura = lerRespostaJson(texto, schema);
      if (leitura.ok) {
        emitir({ ...base, resultado: 'ok' });
        return { dados: leitura.data, status, correlationId, refCredencial: ref };
      }
      const campos = leitura.motivo === 'formato' ? leitura.campos : [];
      const erro = new LiSchemaError({ ...ctx, status, motivo: leitura.motivo, campos });
      emitir({ ...base, resultado: 'schema' });
      throw erro;
    }

    if (status === 401 || status === 403) {
      emitir({ ...base, resultado: 'auth' });
      throw new LiAuthError({ ...ctx, status });
    }
    if (status === 404) {
      emitir({ ...base, resultado: 'nao-encontrado' });
      throw new LiNotFoundError({ ...ctx, status });
    }
    if (status === 429) {
      const limite = extrairEscopoLimite(texto);
      emitir({ ...base, resultado: 'limite', codigoLimite: limite.codigo });
      throw new LiThrottleError({
        ...ctx,
        status,
        escopo: limite.escopo,
        codigosEncontrados: limite.codigosEncontrados,
        retryAfterS,
      });
    }
    emitir({ ...base, resultado: 'http' });
    throw new LiHttpError({ ...ctx, status });
  }

  return { get };
}
