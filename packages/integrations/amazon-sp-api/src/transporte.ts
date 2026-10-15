/**
 * The transport core shared by `client.ts` (SP-API reads) and `lwa.ts` (the
 * token exchanges): the input checks both make, the observer event, and the ONE
 * place a request is sent — deadline, body read, release and the catch ladder.
 *
 * ⚠️ INTERNAL. The barrel (`index.ts`) does not re-export this module; the
 * public constants and the observer types are re-exported from `client.ts`.
 * Two copies of the deadline-and-catch sequence would drift (#1094 fixed the
 * same ladder in five clients one at a time), so both callers go through
 * {@link enviar} and only the STATUS classification stays per destination.
 */
import { abrirPrazo } from '@delfrance/core/wire';

import {
  AmazonNetworkError,
  AmazonTimeoutError,
  type CodigoErroLwa,
  type ContextoRequisicaoAmazon,
  type DestinoAmazon,
  lerLimiteTaxa,
  type MetodoAmazon,
} from './errors';

/** What replaces the access token in the body text handed to the observer. */
export const TOKEN_REMOVIDO = '[token removido]';

/** The longest `ref` accepted; a label, not a payload. */
export const MAX_REF_CREDENCIAL = 64;

/** The longest `user-agent` Amazon accepts [D:connecting-to-the-selling-partner-api]. */
export const MAX_USER_AGENT = 500;

/** Visible ASCII only: no space, tab, line break, control character or non-ASCII. */
const ASCII_VISIVEL = /^[\x21-\x7E]+$/;

/** Printable ASCII: visible ASCII plus the space. */
const ASCII_IMPRIMIVEL = /^[\x20-\x7E]+$/;

/** `x-amzn-RequestId` as we keep it: a plain id, never free text. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/* -------------------------------------------------------------------------- */
/*                                 The checks                                 */
/* -------------------------------------------------------------------------- */

/**
 * A token, secret or code: visible ASCII, at least one character, never
 * trimmed. Checked BEFORE any header is built — Node's `fetch` rejects a header
 * value carrying a control character with a `TypeError` that QUOTES the value.
 */
export function ehAsciiVisivel(valor: unknown): valor is string {
  return typeof valor === 'string' && ASCII_VISIVEL.test(valor);
}

/**
 * The caller's `user-agent`: 1–500 printable ASCII characters with no space at
 * either end. Amazon requires one on every request, recommending
 * `AppId/AppVersionId (Language=…)` [D:connecting-to-the-selling-partner-api].
 * There is no default here: the value names the app, and this package does not
 * get to pick it.
 */
export function userAgentValido(ua: unknown): ua is string {
  return (
    typeof ua === 'string' &&
    ua.length <= MAX_USER_AGENT &&
    ASCII_IMPRIMIVEL.test(ua) &&
    ua.trim() === ua
  );
}

/**
 * The credential label: 1–64 characters, containing none of the request's
 * secrets. An empty secret is refused on its own account (`''` is inside every
 * string), so it is skipped here.
 */
export function refValida(ref: unknown, segredos: readonly string[]): ref is string {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_REF_CREDENCIAL) return false;
  return !segredos.some((s) => s.length > 0 && ref.includes(s));
}

/** Whether any of the secrets appears inside `texto`. */
export function contemSegredo(texto: string, segredos: readonly string[]): boolean {
  return segredos.some((s) => s.length > 0 && texto.includes(s));
}

/**
 * `x-amzn-RequestId`, kept only when it is a plain id (letters, digits, `.`,
 * `_`, `:`, `-`, at most 128) that contains no secret. It rides errors, and an
 * error must never carry free text from a response.
 */
export function lerRequestIdAmazon(
  valor: string | null,
  segredos: readonly string[],
): string | null {
  if (valor === null || !REQUEST_ID.test(valor) || contemSegredo(valor, segredos)) return null;
  return valor;
}

/** `globalThis.fetch`, resolved at CALL time and never detached. */
export function resolverFetch(f: typeof globalThis.fetch | undefined): typeof globalThis.fetch {
  // Some runtimes reject a detached `fetch` ("Illegal invocation"), and a test
  // that stubs the global after construction must still be honoured.
  return f ?? ((input, init) => globalThis.fetch(input, init));
}

/* -------------------------------------------------------------------------- */
/*                                The observer                                */
/* -------------------------------------------------------------------------- */

/** How a request ended, as the observer sees it. */
export type ResultadoChamadaAmazon =
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
 * a request header, the access token, the user-agent or an LWA form field.
 *
 * - SP-API: `corpo` is the full response text with the access token scrubbed
 *   out; the app's logger applies its own allow-list and size cap.
 * - LWA: `corpo` is ALWAYS `null`. A 200 IS the token pair, and an error carries
 *   an `error_description`; every LWA body stays out of the logs.
 *
 * The event exists only in memory.
 */
export interface ChamadaAmazon {
  readonly destino: DestinoAmazon;
  readonly operacao: string;
  readonly metodo: MetodoAmazon;
  /** The path, without the query. */
  readonly caminho: string;
  /** The query entries as sent, raw — the logger's allow-list redacts them. Always `[]` for LWA. */
  readonly query: readonly (readonly [string, string])[];
  readonly correlationId: string;
  /** Amazon's `x-amzn-RequestId`, when the response carried a plain one. */
  readonly requestIdAmazon: string | null;
  readonly refCredencial: string;
  /** `null` when there was no response at all. */
  readonly status: number | null;
  readonly latenciaMs: number;
  readonly resultado: ResultadoChamadaAmazon;
  /** `x-amzn-RateLimit-Limit` (requests per second), read on every response. */
  readonly limiteTaxa: number | null;
  /**
   * SP-API only: the distinct `errors[].code` values of a non-2xx body
   * (printable ASCII, at most 64 characters each, at most 10). `[]` when the
   * body had none — the models' own sandbox answers some 400s with `{}`.
   */
  readonly codigosErro: readonly string[];
  /** LWA only: the `error` code of a non-2xx body. */
  readonly codigoLwa: CodigoErroLwa | null;
  /** See the interface header: scrubbed text for SP-API, always `null` for LWA. */
  readonly corpo: string | null;
}

/** The part of the event that varies per outcome. */
export type ParteDoEvento = Pick<
  ChamadaAmazon,
  'resultado' | 'status' | 'latenciaMs' | 'requestIdAmazon' | 'limiteTaxa' | 'corpo'
> &
  Partial<Pick<ChamadaAmazon, 'codigosErro' | 'codigoLwa'>>;

/**
 * The emitter for ONE request. `levaCorpo: false` (LWA) forces `corpo: null`
 * structurally, whatever a call site passes.
 */
export function criarEmissor(
  fixo: Pick<
    ChamadaAmazon,
    'destino' | 'operacao' | 'metodo' | 'caminho' | 'query' | 'correlationId' | 'refCredencial'
  >,
  levaCorpo: boolean,
  onChamada: ((e: ChamadaAmazon) => void) | undefined,
): (p: ParteDoEvento) => void {
  return (p) => {
    onChamada?.({
      destino: fixo.destino,
      operacao: fixo.operacao,
      metodo: fixo.metodo,
      caminho: fixo.caminho,
      query: fixo.query,
      correlationId: fixo.correlationId,
      requestIdAmazon: p.requestIdAmazon,
      refCredencial: fixo.refCredencial,
      status: p.status,
      latenciaMs: p.latenciaMs,
      resultado: p.resultado,
      limiteTaxa: p.limiteTaxa,
      codigosErro: p.codigosErro ?? [],
      codigoLwa: p.codigoLwa ?? null,
      corpo: levaCorpo ? p.corpo : null,
    });
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Sending                                   */
/* -------------------------------------------------------------------------- */

export interface EnvioAmazon {
  readonly fetchImpl: typeof globalThis.fetch;
  readonly agora: () => number;
  readonly url: string;
  readonly metodo: MetodoAmazon;
  readonly headers: Readonly<Record<string, string>>;
  /** The form body of the LWA POST; absent on a GET. */
  readonly corpo?: string;
  readonly prazoMs: number;
  readonly sinal: AbortSignal | undefined;
  readonly ctx: Omit<ContextoRequisicaoAmazon, 'requestIdAmazon'>;
  /** Every secret of this request, so nothing read back can carry one. */
  readonly segredos: readonly string[];
  readonly emitir: (p: ParteDoEvento) => void;
}

/** A response whose body was read inside the deadline. */
export interface RespostaLida {
  readonly status: number;
  readonly ok: boolean;
  readonly texto: string;
  readonly latenciaMs: number;
  readonly requestIdAmazon: string | null;
  readonly limiteTaxa: number | null;
  readonly ctx: ContextoRequisicaoAmazon;
}

/**
 * Send ONE request and read its body inside one deadline.
 *
 * 1. A caller signal that already aborted rethrows its reason; nothing is sent
 *    and nothing is observed.
 * 2. Open the deadline, `fetch` with `redirect: 'manual'` — a 3xx comes back as
 *    a response and is classified by the caller, never followed, because
 *    following one would resend `x-amz-access-token` (or the LWA form) to
 *    whatever `Location` names — and read the body INSIDE the window, so a
 *    server that sends its headers and then stalls cannot hang past it.
 * 3. On a rejection, emit once and throw: the deadline → `AmazonTimeoutError`;
 *    the caller's own abort → its reason, as-is; a `TypeError` (DNS, TLS, a
 *    connection reset, a body dropped mid-stream) → `AmazonNetworkError`;
 *    anything else → rethrown as-is.
 * 4. Release the deadline in `finally`: the timer is not `unref`'d, so a
 *    forgotten one holds the event loop for the whole window.
 *
 * On success nothing is emitted here: the caller classifies the status and
 * emits exactly once.
 */
export async function enviar(p: EnvioAmazon): Promise<RespostaLida> {
  p.sinal?.throwIfAborted();

  const inicio = p.agora();
  const prazo = abrirPrazo(p.prazoMs, { vincular: p.sinal });
  let res: Response | undefined;
  let texto: string;
  try {
    res = await p.fetchImpl(p.url, {
      method: p.metodo,
      headers: p.headers,
      ...(p.corpo === undefined ? {} : { body: p.corpo }),
      redirect: 'manual',
      signal: prazo.signal,
    });
    texto = await res.text();
  } catch (err) {
    // The headers may have arrived before the failure; their id is still ours.
    const requestIdAmazon =
      res === undefined
        ? null
        : lerRequestIdAmazon(res.headers.get('x-amzn-requestid'), p.segredos);
    const falha = {
      status: res?.status ?? null,
      latenciaMs: p.agora() - inicio,
      requestIdAmazon,
      limiteTaxa:
        res === undefined ? null : lerLimiteTaxa(res.headers.get('x-amzn-ratelimit-limit')),
      corpo: null,
    };
    const ctx: ContextoRequisicaoAmazon = { ...p.ctx, requestIdAmazon };
    // Asked of the deadline itself, never `err instanceof DOMException`:
    // `fetch` rejects with the signal's reason as-is (`prazo.ts`).
    if (prazo.esgotado()) {
      p.emitir({ ...falha, resultado: 'tempo-esgotado' });
      throw new AmazonTimeoutError({ ...ctx, prazoMs: p.prazoMs }, err);
    }
    // The caller's own cancel is theirs: rethrown as itself, never wrapped.
    if (p.sinal?.aborted === true) {
      p.emitir({ ...falha, resultado: 'cancelado' });
      throw err;
    }
    // Both the fetch and a connection dropped MID-BODY reject with a
    // `TypeError` ("terminated" in Node). The header checks made before this
    // call guarantee it cannot quote the token or the user-agent, and the LWA
    // secrets travel in the body, which no `TypeError` quotes.
    if (err instanceof TypeError) {
      p.emitir({ ...falha, resultado: 'rede' });
      throw new AmazonNetworkError(ctx, err);
    }
    p.emitir({ ...falha, resultado: 'inesperado' });
    throw err;
  } finally {
    prazo.liberar();
  }

  const requestIdAmazon = lerRequestIdAmazon(res.headers.get('x-amzn-requestid'), p.segredos);
  return {
    status: res.status,
    ok: res.ok,
    texto,
    latenciaMs: p.agora() - inicio,
    requestIdAmazon,
    limiteTaxa: lerLimiteTaxa(res.headers.get('x-amzn-ratelimit-limit')),
    ctx: { ...p.ctx, requestIdAmazon },
  };
}
