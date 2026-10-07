/**
 * Typed errors raised by the browser `FreightHttpClient`. Each maps to a
 * failure shape the `apps/melhor-envio` freight routes return; the client
 * narrows the HTTP status so callers (`apps/web`) branch on
 * `err instanceof <X>` instead of inspecting numbers. Mirrors the nfe
 * package's `http-provider/errors.ts`.
 */

/**
 * Wire `code`s the `apps/melhor-envio` routes put in their `{ error, code }`
 * envelope and this client reads back. ONE literal for both sides: the server
 * imports these from this browser-safe subpath, so the two cannot drift. (The
 * older `ME_REAUTH` / `ME_LABEL_TERMINAL` predate this and are still written
 * out on each side.)
 */
/** `504` — Melhor Envio itself did not answer in time (`MelhorEnvioTimeoutError`, #1679). */
export const FREIGHT_CODIGO_ME_TIMEOUT = 'ME_TIMEOUT';
/**
 * `423` — another `comprar` for the same pedido holds the in-flight claim
 * (#1677): it is still running, or a paid step of it failed without
 * confirmation and the claim is held until it expires.
 *
 * Emitted by the `comprar` route's claim. Until this client grows a typed arm
 * for it, a 423 reads as a plain `FreightServerError` carrying the route's own
 * message — which is why it is a 423 and never a 409 (see `errorFromResponse`).
 */
export const FREIGHT_CODIGO_COMPRA_EM_ANDAMENTO = 'ME_COMPRA_EM_ANDAMENTO';

/** Base — every HTTP-originated freight error is at least this. */
export class FreightHttpError extends Error {
  public readonly status: number;
  public readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'FreightHttpError';
    this.status = status;
    this.body = body;
  }
}

/** 400 — malformed request body/query (route Zod parse failure). */
export class FreightBadRequestError extends FreightHttpError {
  constructor(message: string, body: unknown) {
    super(message, 400, body);
    this.name = 'FreightBadRequestError';
  }
}

/** 401 / 403 — missing/invalid Firebase ID token or lacking PERM.frete. */
export class FreightAuthError extends FreightHttpError {
  constructor(message: string, status: number, body: unknown) {
    super(message, status, body);
    this.name = 'FreightAuthError';
  }
}

/** 404 — the int_frete / Melhor Envio account doc was not found. */
export class FreightNotFoundError extends FreightHttpError {
  constructor(message: string, body: unknown) {
    super(message, 404, body);
    this.name = 'FreightNotFoundError';
  }
}

/**
 * 409 `{ code: 'ME_REAUTH' }` — the Melhor Envio account must be
 * reconnected (no token, or the 45-day refresh token expired). The UI
 * prompts the user to re-run the OAuth connect.
 */
export class FreightReauthRequiredError extends FreightHttpError {
  constructor(message: string, body: unknown) {
    super(message, 409, body);
    this.name = 'FreightReauthRequiredError';
  }
}

/**
 * 422 — Melhor Envio rejected the request contents (e.g. invalid CEP).
 * `errors` is the field → messages map forwarded from ME.
 */
export class FreightValidationError extends FreightHttpError {
  public readonly errors: Record<string, string[]>;
  constructor(message: string, errors: Record<string, string[]>, body: unknown) {
    super(message, 422, body);
    this.name = 'FreightValidationError';
    this.errors = errors;
  }
}

/**
 * 409 `{ code: 'ME_LABEL_TERMINAL' }` — the label is canceled/suspended at
 * Melhor Envio, so the buy pipeline can't continue. Distinct from
 * `FreightReauthRequiredError` (also 409): the UI prompts the user to generate
 * a fresh label rather than to reconnect the account.
 */
export class FreightLabelTerminalError extends FreightHttpError {
  public readonly reason: string | undefined;
  constructor(message: string, reason: string | undefined, body: unknown) {
    super(message, 409, body);
    this.name = 'FreightLabelTerminalError';
    this.reason = reason;
  }
}

/** 5xx — internal `apps/melhor-envio` failure. */
export class FreightServerError extends FreightHttpError {
  constructor(message: string, status: number, body: unknown) {
    super(message, status, body);
    this.name = 'FreightServerError';
  }
}

/**
 * The route answered 2xx and the body was not the shape this client claims —
 * the wrong fields, no body at all, or not JSON.
 *
 * ⚠️ Nothing here describes what WE send: it is a browser-side `Error` that
 * never leaves the tab, and `status` records the 2xx the ROUTE sent us.
 *
 * ⚠️ A subclass of `FreightHttpError`, so the callers that narrow to that class
 * (and `throw err` for anything else) keep working. A sibling class would land
 * as an unhandled rejection in the checkout's `void`-ed print handlers.
 */
export class FreightSchemaError extends FreightHttpError {
  /** Field PATHS that failed, never values. */
  public readonly campos: string[];
  constructor(message: string, status: number, campos: string[]) {
    super(message, status, null);
    this.name = 'FreightSchemaError';
    this.campos = campos;
  }
}

/**
 * Network-level failure within the first seconds of a request — DNS, connection
 * refused, a CORS refusal, a connection dropped while the body was still
 * arriving. No complete response arrived. ⚠️ That does NOT mean the route never
 * RAN — a connection can drop after the request left — so a caller that re-sends
 * a buy on this error is making the same bet `FreightTimeoutError` spells out. A
 * failure that arrives LATE is a `FreightTimeoutError`.
 */
export class FreightNetworkError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'FreightNetworkError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The request's OUTCOME IS UNKNOWN (#1094): this client's own deadline expired
 * (`origem: 'prazo'`), or the platform gateway gave up on the request
 * (`origem: 'gateway'`) — read as a 504 no route of ours wrote when the caller
 * can see the status, and in a cross-origin browser (where that 504 carries no
 * CORS headers) as a network failure after the request had been in flight past
 * `LIMIAR_FALHA_TARDIA_MS` — or the route answered that MELHOR ENVIO stopped
 * answering it (`origem: 'provedor'`, a `504 { code: 'ME_TIMEOUT' }`, #1679),
 * which on a buy can mean the label was paid all the same.
 *
 * ⚠️ Either way something may still be running it — for `'prazo'`/`'gateway'`
 * the server (no route observes a client abort, and Cloud Run keeps processing
 * after its own 504); for `'provedor'` Melhor Envio itself, which never learns
 * the route stopped waiting. So the message says so, and nothing in this repo
 * re-sends automatically on it.
 *
 * ⚠️ A SUBCLASS of `FreightNetworkError`, never a sibling: every freight catch
 * site narrows on `FreightHttpError` / `FreightNetworkError` (or on
 * `freightErrorMessage` returning `null`) and rethrows anything else, so a
 * sibling class would land as an unhandled rejection in the checkout's
 * `void`-ed print handlers. Code that wants the distinct copy puts a
 * `FreightTimeoutError` arm BEFORE its `FreightNetworkError` arm.
 */
export class FreightTimeoutError extends FreightNetworkError {
  public readonly origem: 'prazo' | 'gateway' | 'provedor';
  /**
   * The deadline that expired: ours for `'prazo'`, the route's per-call Melhor
   * Envio deadline for `'provedor'` (when it sent one), `null` for a gateway 504
   * (the platform's clock, which nobody reports).
   */
  public readonly timeoutMs: number | null;
  /** The client method that timed out (`'comprar'`, `'conta'`, …). */
  public readonly operacao: string;
  constructor(
    message: string,
    detalhes: {
      readonly origem: 'prazo' | 'gateway' | 'provedor';
      readonly timeoutMs: number | null;
      readonly operacao: string;
    },
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = 'FreightTimeoutError';
    this.origem = detalhes.origem;
    this.timeoutMs = detalhes.timeoutMs;
    this.operacao = detalhes.operacao;
  }
}
