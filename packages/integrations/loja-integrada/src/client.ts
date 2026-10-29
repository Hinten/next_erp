/**
 * The Loja Integrada transport: the shared request core (`executarLi`) and the
 * READ client built on it, `criarClienteLeituraLi`. The write client is a
 * separate factory in `escrita.ts`, over the same core.
 *
 * ## The read client has no write method, by construction
 *
 * `criarClienteLeituraLi` returns `{ get }` and nothing else, and `get` takes
 * no body and hard-wires the verb: every request it makes is a `GET`. There is
 * no flag to flip, no verb parameter, no body to fill. The package's only
 * writer is `escrita.ts`, a different factory with different method names, so a
 * read client handed to some code can never write.
 *
 * ⚠️ `executarLi` and its helpers are exported for `escrita.ts` ONLY. Two things
 * keep them inside the package: the barrel (`index.ts`) names this module's
 * public exports one by one and leaves them out, and the package manifest's
 * `exports` map publishes the root alone, so a deep import of this file
 * (`…/src/client`) does not resolve. And whatever reaches the core, a `PUT`
 * gets only as far as the write routes (`rotasEscrita.ts`, step 1 below).
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
 *   of them. A write's body is checked the same way (`'token-no-corpo'`).
 *
 * ## Each request, in order
 *
 *  1. Validate the path (`/v1/…`, no `?`, `#`, `://`, `..` or an encoded `.`,
 *     `/` or `\`, and unchanged by the URL parser). For a `PUT`, the path must
 *     also be one of the write routes, and the body must pass THAT route's
 *     schema (`rotasEscrita.ts`); the body sent is the schema's output,
 *     serialised once.
 *  2. `await obterCredencial()` — OUTSIDE the deadline, so a slow getter does not
 *     eat the call's budget — then validate the token and the `ref`; for a
 *     `PUT`, refuse a serialised body that carries the token; refuse a URL that
 *     carries it.
 *  3. Generate the correlation id (even when the header is off, so the app's
 *     logs still correlate).
 *  4. Build exactly `Authorization`, `Accept`, `Content-Type: application/json`
 *     on a `PUT` only, and, when enabled, `x-correlation-id`.
 *  5. Open the deadline of the verb's class (`PRAZO_LI_MS`), `fetch` with
 *     `redirect: 'manual'`, read the body INSIDE the window, release the
 *     deadline in `finally`.
 *  6. Classify the outcome into the `errors.ts` taxonomy. A 2xx is handed to the
 *     client that sent the request (`ler2xx`): the read client parses it with
 *     its schema and throws `LiSchemaError` when it does not fit; the write
 *     client reports its echo and never throws (`escrita.ts`). Every non-2xx is
 *     classified here, identically for both verbs.
 *  7. Call `onChamada` once, then return or throw.
 *
 * ⚠️ **Redirects are never followed.** A 3xx is a `LiHttpError`. Following one
 * would double the calls silently, could carry the `Authorization` header to a
 * target nobody chose, and for a write would re-send the body there.
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
  type MetodoLi,
} from './errors';
import { type ClasseOperacaoLi, PRAZO_LI_MS } from './prazos';
import { rotaDeEscritaLi } from './rotasEscrita';

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

/** The deadline class of each verb: a `GET` is a read, a `PUT` a write. */
const CLASSE_DO_METODO = {
  GET: 'leitura',
  PUT: 'escrita',
} as const satisfies Record<MetodoLi, ClasseOperacaoLi>;

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
 * the token, a request header, `Authorization` or the REQUEST body. `corpo` is
 * the full response text with the token scrubbed out; the app's logger applies
 * its own allow-list and size cap. The event exists only in memory.
 *
 * On a write whose 2xx body read was cut, `resultado` names what happened to
 * the read (`rede`, `tempo-esgotado`) and `status` the 2xx that arrived; the
 * write itself still resolved (`escrita.ts`).
 */
export interface ChamadaLi {
  readonly operacao: string;
  readonly metodo: MetodoLi;
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
   * ⚠️ An observer that throws propagates in place of the outcome — rule 6
   * forbids the generic catch that would swallow it. Harmless for a GET; for a
   * write it REJECTS a write that landed (`escrita.ts`), so a write client's
   * observer must be total, and its caller pins that with a test (the app's
   * logger does, over every write outcome).
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

/* -------------------------------------------------------------------------- */
/*                 The shared core (package-internal, see header)              */
/* -------------------------------------------------------------------------- */

/** A 2xx whose body was read IN FULL, handed to the client that sent it. */
export interface Resposta2xxLi {
  readonly status: number;
  /** The raw text: what a parse reads, so a scrub can never alter the data. */
  readonly texto: string;
  /** The same text with the token scrubbed: what the observer gets. */
  readonly corpo: string;
  readonly correlationId: string;
  readonly refCredencial: string;
  /** The request's error context, verb included, for an error built from it. */
  readonly ctx: ContextoRequisicaoLi;
}

/** What a client makes of a 2xx: a value, or a schema failure the core throws. */
export type Desfecho2xxLi<R> =
  | { readonly resultado: 'ok'; readonly valor: R }
  | { readonly resultado: 'schema'; readonly erro: LiSchemaError };

/** A 2xx whose BODY read was then cut (the deadline, or a dropped connection). */
export interface Corte2xxLi {
  readonly status: number;
  readonly correlationId: string;
  readonly refCredencial: string;
}

interface ExecucaoBaseLi<R> {
  readonly operacao: string;
  readonly caminho: string;
  readonly sinal?: AbortSignal;
  /** What a 2xx whose body was read in full means — the one step the clients differ on. */
  readonly ler2xx: (r: Resposta2xxLi) => Desfecho2xxLi<R>;
}

/**
 * One request for the core. A `GET` carries a query and never a body; a `PUT`
 * always carries a body — the caller's, as given: the core parses it with its
 * ROUTE's schema (`rotasEscrita.ts`) and serialises that output — and says what
 * a 2xx with a cut body resolves to (the write landed, so it must not throw).
 */
export type ExecucaoLi<R> = ExecucaoBaseLi<R> &
  (
    | {
        readonly metodo: 'GET';
        readonly query?: Readonly<Record<string, string | number | boolean>>;
      }
    | {
        readonly metodo: 'PUT';
        readonly corpo: unknown;
        readonly corte2xx: (c: Corte2xxLi) => R;
      }
  );

/**
 * The exact text of a `PUT`'s body, or a refusal before the credential is read:
 * the path must be one of the write routes, and the body must pass THAT route's
 * schema. The text is that schema's OUTPUT, serialised once — never the
 * caller's object, which could carry a key or a `toJSON` the schema never saw.
 */
function textoDoCorpoLi(caminho: string, corpo: unknown, operacao: string): string {
  const rota = rotaDeEscritaLi(caminho);
  if (rota === null) {
    throw new LiConfigError('rota-nao-permitida', { operacao, refCredencial: null });
  }
  const lido = rota.corpo.safeParse(corpo);
  if (!lido.success) throw new LiConfigError('corpo', { operacao, refCredencial: null });
  return JSON.stringify(lido.data);
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

/**
 * Whether the token appears in a serialised request body.
 *
 * ⚠️ Checked on the TEXT that is sent, in two spellings: as written, and as
 * JSON writes it inside a string. A visible-ASCII token may hold `"` or `\`,
 * which `JSON.stringify` escapes (`\"`, `\\`), so the raw token never occurs
 * verbatim in the body that would carry it — and the server decodes it back.
 */
function tokenNoCorpo(token: string, textoCorpo: string): boolean {
  const escapado = JSON.stringify(token).slice(1, -1);
  return textoCorpo.includes(token) || textoCorpo.includes(escapado);
}

/**
 * The 2xx reading of every `GET`: the body must parse with its schema, or the
 * request fails with `LiSchemaError` — a read is never "resolved" without its
 * data. `montar` shapes the value from the parsed data.
 */
export function lerComSchemaLi<S extends z.ZodType, R>(
  schema: S,
  montar: (dados: z.infer<S>, r: Resposta2xxLi) => R,
): (r: Resposta2xxLi) => Desfecho2xxLi<R> {
  return (r) => {
    const leitura = lerRespostaJson(r.texto, schema);
    if (leitura.ok) return { resultado: 'ok', valor: montar(leitura.data, r) };
    const campos = leitura.motivo === 'formato' ? leitura.campos : [];
    const erro = new LiSchemaError({ ...r.ctx, status: r.status, motivo: leitura.motivo, campos });
    return { resultado: 'schema', erro };
  };
}

/**
 * The request core both clients call (module header, "Each request, in
 * order"). Package-internal: the barrel does not export it.
 */
export async function executarLi<R>(opts: OpcoesClienteLi, p: ExecucaoLi<R>): Promise<R> {
  const { metodo, operacao, caminho, sinal } = p;
  // Resolved at call time, and never called unbound: some runtimes reject a
  // detached `fetch` ("Illegal invocation").
  const fetchImpl: typeof globalThis.fetch =
    opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const gerarCorrelationId = opts.gerarCorrelationId ?? (() => globalThis.crypto.randomUUID());
  const enviarCorrelationId = opts.enviarCorrelationId ?? true;
  const agora = opts.agora ?? (() => Date.now());

  // 1. The path. Its message never echoes it: a malformed one may carry a query.
  if (!caminhoValido(caminho)) {
    throw new LiConfigError('caminho', { operacao, refCredencial: null });
  }
  // A `PUT` reaches a write route only, with that route's body; serialised
  // ONCE, so the text checked below is exactly the text sent.
  const textoCorpo = p.metodo === 'PUT' ? textoDoCorpoLi(caminho, p.corpo, operacao) : null;

  // 2. The credential, OUTSIDE the deadline, every time.
  const credencial = await opts.obterCredencial();
  validarCredencial(credencial, operacao);
  const { token, ref } = credencial;

  if (textoCorpo !== null && tokenNoCorpo(token, textoCorpo)) {
    throw new LiConfigError('token-no-corpo', { operacao, refCredencial: ref });
  }

  const query: readonly (readonly [string, string])[] =
    p.metodo === 'GET'
      ? Object.entries(p.query ?? {}).map(([k, v]) => [k, String(v)] as const)
      : [];
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
  if (textoCorpo !== null) headers['Content-Type'] = 'application/json';
  if (enviarCorrelationId) headers['x-correlation-id'] = correlationId;

  const ctx: ContextoRequisicaoLi = {
    operacao,
    caminho,
    correlationId,
    refCredencial: ref,
    metodo,
  };
  const emitir = (
    e: Pick<ChamadaLi, 'resultado' | 'status' | 'latenciaMs' | 'corpo'> &
      Partial<Pick<ChamadaLi, 'codigoLimite' | 'retryAfterS'>>,
  ): void => {
    opts.onChamada?.({
      operacao,
      metodo,
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
  const prazoMs = PRAZO_LI_MS[CLASSE_DO_METODO[metodo]];
  const inicio = agora();
  const prazo = abrirPrazo(prazoMs, { vincular: sinal });
  let res: Response | undefined;
  let texto: string;
  try {
    res = await fetchImpl(url, {
      method: metodo,
      headers,
      ...(textoCorpo === null ? {} : { body: textoCorpo }),
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
    // A WRITE answered 2xx before its body read failed: it landed, so the
    // deadline or a dropped connection here resolves instead of throwing.
    const corte: Corte2xxLi | null =
      p.metodo === 'PUT' && res?.ok === true
        ? { status: res.status, correlationId, refCredencial: ref }
        : null;
    // Asked of the deadline itself, never `err instanceof DOMException`:
    // `fetch` rejects with the signal's reason as-is (`prazo.ts`).
    if (prazo.esgotado()) {
      emitir({ ...falha, resultado: 'tempo-esgotado' });
      if (corte !== null && p.metodo === 'PUT') return p.corte2xx(corte);
      throw new LiTimeoutError({ ...ctx, prazoMs }, err);
    }
    // The caller's own cancel is theirs: rethrown as itself, never wrapped —
    // even after a 2xx write, which the caller then re-derives from a read.
    if (sinal?.aborted === true) {
      emitir({ ...falha, resultado: 'cancelado' });
      throw err;
    }
    // Both the fetch and a connection dropped MID-BODY reject with a
    // `TypeError` ("terminated" in Node). The token check above guarantees
    // this one cannot quote the token.
    if (err instanceof TypeError) {
      emitir({ ...falha, resultado: 'rede' });
      if (corte !== null && p.metodo === 'PUT') return p.corte2xx(corte);
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
    const desfecho = p.ler2xx({ status, texto, corpo, correlationId, refCredencial: ref, ctx });
    emitir({ ...base, resultado: desfecho.resultado });
    if (desfecho.resultado === 'schema') throw desfecho.erro;
    return desfecho.valor;
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

/* -------------------------------------------------------------------------- */
/*                               The read client                              */
/* -------------------------------------------------------------------------- */

export function criarClienteLeituraLi(opts: OpcoesClienteLi): LiLeituraClient {
  async function get<S extends z.ZodType>(p: PedidoGetLi<S>): Promise<RespostaLi<z.infer<S>>> {
    // The verb is hard-wired: this client has no other.
    return executarLi(opts, {
      metodo: 'GET',
      operacao: p.operacao,
      caminho: p.caminho,
      query: p.query,
      sinal: p.sinal,
      ler2xx: lerComSchemaLi(p.schema, (dados, r) => ({
        dados,
        status: r.status,
        correlationId: r.correlationId,
        refCredencial: r.refCredencial,
      })),
    });
  }

  return { get };
}
