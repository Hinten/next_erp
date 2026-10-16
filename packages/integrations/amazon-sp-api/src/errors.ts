/**
 * Typed error hierarchy for the Amazon Selling Partner API client and the Login
 * with Amazon (LWA) token exchanges, plus the two readers an error needs
 * (`lerLimiteTaxa`, `lerCodigoErroLwa`).
 *
 * Every class roots at {@link AmazonError}, so a caller narrows with
 * `instanceof` (repo rule 6) and maps the class to an HTTP answer, a parking
 * decision or a retry. The HTTP subclasses root at {@link AmazonHttpError}; the
 * 2xx-with-a-bad-body class ({@link AmazonSchemaError}) and the transport
 * classes do NOT, so an `instanceof AmazonHttpError` arm can never swallow them.
 *
 * ## What an error may carry
 *
 * ⚠️ **No part of a response body, ever.** An SP-API body echoes request values
 * and can carry a buyer's name, address or CPF; an LWA body is either a token
 * pair or an `error_description`. An error travels further than any log line:
 * into `err.message`, a route's 5xx answer, a durable failure doc. An SP-API
 * body reaches exactly one place, the `onChamada` observer (`client.ts`),
 * already scrubbed of the access token; an LWA body reaches nothing at all.
 *
 * ⚠️ **No token or secret, ever.** Not the access token, the refresh token, the
 * authorization code or the client secret, and not the `message` of a caught
 * platform error (an aborted `fetch` can echo its URL; a header `TypeError`
 * quotes the header value). That is why every message is BUILT HERE from
 * structured fields rather than passed in by the caller: a call site cannot add
 * text to one. Messages name the operation, the method and the path — never the
 * query, which may carry filter values.
 *
 * `refCredencial` is the opaque, non-secret label the caller handed in with the
 * credential, echoed so the app can tell WHICH credential a 401 belonged to. It
 * is `null` only when the error was raised before the credential was known, or
 * when echoing it is unsafe (a rejected token or a rejected `ref`).
 */
import { parseWireDecimal, resumirCampos } from '@delfrance/core/wire';

/* -------------------------------------------------------------------------- */
/*                                  Readers                                   */
/* -------------------------------------------------------------------------- */

/**
 * `x-amzn-RateLimit-Limit` as requests per second, or `null`.
 *
 * The header is a decimal string (`'2.0'`, `'0.0167'`) [D:usage-plans-and-rate-limits].
 * Read through `parseWireDecimal`, never a bare `Number()` (which reads `'0x1F'`
 * as 31 and `'1e3'` as 1000) and never with a locale guess (`'1,5'`). Only a
 * finite, strictly positive rate means anything; everything else is `null`.
 *
 * ⚠️ Amazon returns this header only "if available", and only on 20x, 400 and
 * 404 — a 429 normally carries NONE, and the docs say not to depend on it. So
 * {@link AmazonThrottleError.limiteTaxa} is usually `null`, and the client reads
 * the header on EVERY response so later pacing has a value from a success.
 */
export function lerLimiteTaxa(valor: string | null | undefined): number | null {
  if (valor === null || valor === undefined) return null;
  const n = parseWireDecimal(valor);
  return n !== null && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The `error` code of an LWA token-endpoint failure, as a closed set.
 *
 * The LWA documentation lists `invalid_request`, `invalid_client`,
 * `invalid_grant`, `unauthorized_client`, `unsupported_grant_type` and
 * `ServerError` (CamelCase, sic)
 * [LWA: https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html,
 * the Login with Amazon docs, NOT the SP-API host the `D:` prefix names];
 * Amazon's own Java SP-API client adds `invalid_scope`, `access_denied` and
 * `temporarily_unavailable` (RFC 6749 names) and spells the server one
 * `server_error`. Both spellings of the server code map to `server_error`;
 * anything else is `'outro'`.
 */
export type CodigoErroLwa =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'outro';

/**
 * Wire text → code. Exact spellings only: a guessed case fold is a guess.
 *
 * ⚠️ A `Map`, not an object literal: `obj['toString']` answers the prototype's
 * function, so an LWA body saying `{"error": "toString"}` would read as a code.
 */
const CODIGO_LWA_POR_TEXTO: ReadonlyMap<string, CodigoErroLwa> = new Map<string, CodigoErroLwa>([
  ['invalid_request', 'invalid_request'],
  ['invalid_client', 'invalid_client'],
  ['invalid_grant', 'invalid_grant'],
  ['unauthorized_client', 'unauthorized_client'],
  ['unsupported_grant_type', 'unsupported_grant_type'],
  ['invalid_scope', 'invalid_scope'],
  ['access_denied', 'access_denied'],
  ['server_error', 'server_error'],
  ['ServerError', 'server_error'],
  ['temporarily_unavailable', 'temporarily_unavailable'],
]);

/**
 * Read an LWA `error` value: a documented code, `'outro'` for any other string,
 * or `null` when there is no string at all (no body, not JSON, no `error`).
 *
 * ⚠️ Only the CODE is ever read. `error_description` is free text from the
 * provider and never reaches an error, an event or a log.
 */
export function lerCodigoErroLwa(valor: unknown): CodigoErroLwa | null {
  if (typeof valor !== 'string') return null;
  return CODIGO_LWA_POR_TEXTO.get(valor) ?? 'outro';
}

/* -------------------------------------------------------------------------- */
/*                                 The classes                                */
/* -------------------------------------------------------------------------- */

/** Which Amazon endpoint a request went to. */
export type DestinoAmazon = 'sp-api' | 'lwa';

/** The only two methods this package sends: SP-API reads and the LWA token POST. */
export type MetodoAmazon = 'GET' | 'POST';

/** What identifies one request on every error raised after it was built. */
export interface ContextoRequisicaoAmazon {
  readonly destino: DestinoAmazon;
  /** The caller's label for the call (`'getMarketplaceParticipations'`, `'trocarRefreshToken'`). */
  readonly operacao: string;
  readonly metodo: MetodoAmazon;
  /** The path only — never the query, which may carry filter values. */
  readonly caminho: string;
  /** Generated locally for our own logs; never sent (Amazon documents no such header). */
  readonly correlationId: string;
  /**
   * Amazon's `x-amzn-RequestId` response header — "provide this if you contact
   * us for support" [D:response-format] — or `null` when there was no response
   * or the value was not a plain id.
   */
  readonly requestIdAmazon: string | null;
  readonly refCredencial: string;
}

/** Base class for every error this package raises. */
export class AmazonError extends Error {
  /** The caller's opaque credential label, or `null` (see the module header). */
  readonly refCredencial: string | null;
  override readonly cause: unknown;

  constructor(
    message: string,
    init: { readonly refCredencial: string | null; readonly cause?: unknown },
  ) {
    super(message);
    this.name = 'AmazonError';
    this.refCredencial = init.refCredencial;
    this.cause = init.cause;
  }
}

/** Why a request was refused before anything was sent. */
export type MotivoConfigAmazon =
  | 'token'
  | 'ref'
  | 'caminho'
  | 'token-na-url'
  | 'user-agent'
  | 'credencial-lwa'
  | 'redirect-uri';

/**
 * OUR input was unusable, and **no request was made**.
 *
 * - `'token'` — the SP-API access token is empty, or has a character outside
 *   visible ASCII (`\x21-\x7E`): whitespace, a line break, a control character,
 *   anything non-ASCII.
 * - `'ref'` — empty, longer than 64 characters, or containing a secret.
 * - `'caminho'` — not `/<api>/…`, carrying `?`, `#`, `://`, `..` or an encoded
 *   `.`, `/` or `\`, or rewritten by the URL parser (a tab, a `%2e%2e` segment).
 * - `'token-na-url'` — the access token appears in the path or in a query key or
 *   value. It travels in `x-amz-access-token` only.
 * - `'user-agent'` — missing, empty, longer than 500 characters, outside
 *   printable ASCII, with a leading or trailing space, or containing a secret.
 *   Amazon requires one on every request [D:connecting-to-the-selling-partner-api].
 * - `'credencial-lwa'` — a client id, client secret, refresh token or
 *   authorization code that is empty or outside visible ASCII.
 * - `'redirect-uri'` — not an absolute `https:` URL, or carrying a fragment or
 *   userinfo.
 *
 * ⚠️ The message never echoes the offending value: a rejected token is still a
 * token, a rejected `ref` may contain one, and a rejected path may carry a query.
 */
export class AmazonConfigError extends AmazonError {
  readonly motivo: MotivoConfigAmazon;
  readonly operacao: string;

  constructor(
    motivo: MotivoConfigAmazon,
    init: { readonly operacao: string; readonly refCredencial: string | null },
  ) {
    super(mensagemDeConfig(motivo, init.operacao), { refCredencial: init.refCredencial });
    this.name = 'AmazonConfigError';
    this.motivo = motivo;
    this.operacao = init.operacao;
  }
}

function mensagemDeConfig(motivo: MotivoConfigAmazon, operacao: string): string {
  const prefixo = `Amazon (${operacao}):`;
  const nada = 'Nada foi enviado.';
  switch (motivo) {
    case 'token':
      return `${prefixo} o access token está vazio ou tem caractere fora do ASCII visível (espaço, quebra de linha, caractere de controle ou acento). ${nada}`;
    case 'ref':
      return `${prefixo} a referência da credencial está vazia, passa de 64 caracteres ou contém um segredo. ${nada}`;
    case 'caminho':
      return `${prefixo} o caminho precisa ter a forma /<api>/…, não pode conter ?, #, :// ou ".." (nem codificados) e precisa chegar ao servidor exatamente como foi escrito. ${nada}`;
    case 'token-na-url':
      return `${prefixo} o access token aparece no caminho ou na query; ele só pode viajar no cabeçalho x-amz-access-token. ${nada}`;
    case 'user-agent':
      return `${prefixo} o user-agent é obrigatório: de 1 a 500 caracteres ASCII imprimíveis, sem espaço nas pontas e sem conter um segredo. ${nada}`;
    case 'credencial-lwa':
      return `${prefixo} o client id, o client secret, o refresh token ou o código de autorização está vazio ou tem caractere fora do ASCII visível. ${nada}`;
    case 'redirect-uri':
      return `${prefixo} o redirect_uri precisa ser uma URL https absoluta, sem fragmento (#) e sem usuário ou senha. ${nada}`;
  }
}

/** How the destination is named in a message. */
function nomeDestino(destino: DestinoAmazon): string {
  return destino === 'lwa' ? 'A Amazon (LWA)' : 'A Amazon (SP-API)';
}

/** `getOrder (GET /orders/2026-01-01/orders/…)` — operation, method, path; no query. */
function onde(ctx: ContextoRequisicaoAmazon): string {
  return `${ctx.operacao} (${ctx.metodo} ${ctx.caminho})`;
}

/**
 * A non-2xx is transient when a later identical request can succeed: 429
 * ("a retry-able status code" [D:usage-plans-and-rate-limits]) and 5xx (503 is
 * "temporary overloading or maintenance"). Everything else — 400, 409, 413,
 * 415, 422, a 3xx — is a caller or state error that repeating cannot fix.
 */
function ehTransitorio(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * A non-2xx that no subclass below claims — including a 3xx (redirects are
 * never followed, so a moved endpoint fails visibly), 400, 409, 413, 415, 422,
 * and an LWA 4xx whose `error` is not a credential code (`invalid_request` /
 * `unsupported_grant_type`, our own bug; `invalid_scope`, `access_denied`, an
 * unknown code).
 *
 * `transitorio` is `true` for 5xx and 429, `false` otherwise.
 */
export class AmazonHttpError extends AmazonError {
  readonly status: number;
  readonly transitorio: boolean;
  readonly destino: DestinoAmazon;
  readonly operacao: string;
  readonly metodo: MetodoAmazon;
  readonly caminho: string;
  readonly correlationId: string;
  readonly requestIdAmazon: string | null;

  constructor(init: ContextoRequisicaoAmazon & { readonly status: number }, mensagem?: string) {
    super(
      mensagem ??
        `${nomeDestino(init.destino)} respondeu HTTP ${String(init.status)} em ${onde(init)}.`,
      { refCredencial: init.refCredencial },
    );
    this.name = 'AmazonHttpError';
    this.status = init.status;
    this.transitorio = ehTransitorio(init.status);
    this.destino = init.destino;
    this.operacao = init.operacao;
    this.metodo = init.metodo;
    this.caminho = init.caminho;
    this.correlationId = init.correlationId;
    this.requestIdAmazon = init.requestIdAmazon;
  }
}

/**
 * The credential was refused.
 *
 * - SP-API (`destino: 'sp-api'`): HTTP 401 or 403. ⚠️ A 403 is AMBIGUOUS: the
 *   models describe it as "Access Denied, Unauthorized, Expired Token, or
 *   Invalid Signature", and a missing role answers 403 too. An expired cached
 *   access token is fixed by a refresh; a revoked authorization, a missing role
 *   or an unrotated client secret is not. The `errors[].code` of the body rides
 *   the observer event (`codigosErro`), never this error.
 * - LWA (`destino: 'lwa'`): HTTP 401 or 403, or a 4xx whose `error` is a
 *   credential failure — `invalid_grant` (a revoked or invalid refresh token,
 *   or an authorization code that expired after its 5 minutes or was already
 *   used), `invalid_client` (OUR client secret refused: wrong, or past its
 *   180-day rotation) or `unauthorized_client`. `codigoLwa` says which.
 *
 * ⚠️ So this is the INPUT to the parking decision, not the decision: an
 * `invalid_client` means the app's secret, not the seller's authorization, and
 * an `invalid_grant` from the code exchange means "restart consent", not "park
 * the conta". The app decides from `destino`, `codigoLwa` and `operacao`, and
 * compares `refCredencial` so a refusal of an older credential parks nothing.
 */
export class AmazonAuthError extends AmazonHttpError {
  /** The LWA `error` code; `null` for SP-API and for an LWA body without one. */
  readonly codigoLwa: CodigoErroLwa | null;

  constructor(
    init: ContextoRequisicaoAmazon & {
      readonly status: number;
      readonly codigoLwa: CodigoErroLwa | null;
    },
  ) {
    const codigo = init.codigoLwa === null ? '' : `, ${init.codigoLwa}`;
    super(
      init,
      `${nomeDestino(init.destino)} recusou a credencial (HTTP ${String(init.status)}${codigo}) em ${onde(init)}.`,
    );
    this.name = 'AmazonAuthError';
    this.codigoLwa = init.codigoLwa;
  }
}

/** 404: "The resource specified does not exist." Not transient. */
export class AmazonNotFoundError extends AmazonHttpError {
  constructor(init: ContextoRequisicaoAmazon & { readonly status: number }) {
    super(
      init,
      `${nomeDestino(init.destino)} respondeu HTTP 404 (não encontrado) em ${onde(init)}.`,
    );
    this.name = 'AmazonNotFoundError';
  }
}

/**
 * 429. Always `transitorio: true`: a throttle is the textbook case for backing
 * off and retrying. Amazon documents no `Retry-After`, so none is read.
 */
export class AmazonThrottleError extends AmazonHttpError {
  /**
   * `x-amzn-RateLimit-Limit` in requests per second, when the 429 carried it —
   * which it normally does not (see {@link lerLimiteTaxa}).
   */
  readonly limiteTaxa: number | null;

  constructor(
    init: ContextoRequisicaoAmazon & {
      readonly status: number;
      readonly limiteTaxa: number | null;
    },
  ) {
    super(
      init,
      `${nomeDestino(init.destino)} limitou as requisições (HTTP ${String(init.status)}) em ${onde(init)}.`,
    );
    this.name = 'AmazonThrottleError';
    this.limiteTaxa = init.limiteTaxa;
  }
}

/** How a 2xx body failed to be what we expect. */
export type MotivoSchemaAmazon = 'vazio' | 'nao-json' | 'formato';

/**
 * A 2xx whose body is not what the schema says.
 *
 * `campos` holds field PATHS only (`payload[].marketplace.id`), never values —
 * the same rule as `lerRespostaJson`. A `'nao-json'` body (a proxy's HTML page)
 * is dropped whole.
 */
export class AmazonSchemaError extends AmazonError {
  readonly status: number;
  readonly motivo: MotivoSchemaAmazon;
  readonly campos: readonly string[];
  readonly destino: DestinoAmazon;
  readonly operacao: string;
  readonly metodo: MetodoAmazon;
  readonly caminho: string;
  readonly correlationId: string;
  readonly requestIdAmazon: string | null;

  constructor(
    init: ContextoRequisicaoAmazon & {
      readonly status: number;
      readonly motivo: MotivoSchemaAmazon;
      readonly campos: readonly string[];
    },
  ) {
    super(mensagemDeSchema(init), { refCredencial: init.refCredencial });
    this.name = 'AmazonSchemaError';
    this.status = init.status;
    this.motivo = init.motivo;
    this.campos = init.campos;
    this.destino = init.destino;
    this.operacao = init.operacao;
    this.metodo = init.metodo;
    this.caminho = init.caminho;
    this.correlationId = init.correlationId;
    this.requestIdAmazon = init.requestIdAmazon;
  }
}

function mensagemDeSchema(
  init: ContextoRequisicaoAmazon & {
    readonly status: number;
    readonly motivo: MotivoSchemaAmazon;
    readonly campos: readonly string[];
  },
): string {
  const quem = nomeDestino(init.destino);
  const http = `HTTP ${String(init.status)}`;
  switch (init.motivo) {
    case 'vazio':
      return `${quem} respondeu ${http} sem corpo em ${onde(init)}.`;
    case 'nao-json':
      return `${quem} respondeu ${http} com um corpo que não é JSON em ${onde(init)}.`;
    case 'formato':
      return `${quem} respondeu ${http} fora do formato esperado em ${onde(init)}. Campos inválidos: ${resumirCampos(init.campos)}.`;
  }
}

/**
 * The transport failed: `fetch` rejected with a `TypeError` (DNS, TLS, a reset
 * connection), or the connection dropped while the BODY streamed.
 *
 * The original `TypeError` rides as `cause`; its `message` is never copied into
 * this one. `requestIdAmazon` is set when the headers arrived before the drop.
 */
export class AmazonNetworkError extends AmazonError {
  readonly destino: DestinoAmazon;
  readonly operacao: string;
  readonly metodo: MetodoAmazon;
  readonly caminho: string;
  readonly correlationId: string;
  readonly requestIdAmazon: string | null;

  constructor(init: ContextoRequisicaoAmazon, cause: unknown, mensagem?: string) {
    super(mensagem ?? `Falha de rede ao chamar a Amazon em ${onde(init)}.`, {
      refCredencial: init.refCredencial,
      cause,
    });
    this.name = 'AmazonNetworkError';
    this.destino = init.destino;
    this.operacao = init.operacao;
    this.metodo = init.metodo;
    this.caminho = init.caminho;
    this.correlationId = init.correlationId;
    this.requestIdAmazon = init.requestIdAmazon;
  }
}

/**
 * The per-call deadline (`PRAZO_AMAZON_MS`) passed. The outcome is unknown —
 * the request may have been served. For an SP-API read or a refresh exchange
 * that only means "try again"; for an authorization-code exchange it may mean
 * the single-use code is already spent (`prazos.ts`). Subclasses
 * {@link AmazonNetworkError}, as `LiTimeoutError` does, so a network arm keeps
 * catching it.
 */
export class AmazonTimeoutError extends AmazonNetworkError {
  readonly prazoMs: number;

  constructor(init: ContextoRequisicaoAmazon & { readonly prazoMs: number }, cause: unknown) {
    super(
      init,
      cause,
      `A Amazon não respondeu em ${String(init.prazoMs / 1000)} s em ${onde(init)}.`,
    );
    this.name = 'AmazonTimeoutError';
    this.prazoMs = init.prazoMs;
  }
}
