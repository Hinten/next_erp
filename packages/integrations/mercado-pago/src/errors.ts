/**
 * Typed error hierarchy for the Mercado Pago integration. Every `catch` in
 * this package narrows on one of these (or a known platform error) and rethrows
 * anything else — no generic catch (repo rule). Callers branch on `instanceof`
 * to map to HTTP responses / re-auth prompts.
 */

/** Base class for every error this package raises. */
export class MercadoPagoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MercadoPagoError';
  }
}

/** A non-2xx response from a Mercado Pago REST endpoint. */
export class MercadoPagoHttpError extends MercadoPagoError {
  constructor(
    message: string,
    readonly status: number,
    /** The parsed error body, when JSON; the raw text otherwise. */
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'MercadoPagoHttpError';
  }
}

/** A response that did not match the expected Zod schema (MP changed a field). */
export class MercadoPagoValidationError extends MercadoPagoError {
  constructor(
    message: string,
    readonly issues: unknown,
  ) {
    super(message);
    this.name = 'MercadoPagoValidationError';
  }
}

/**
 * The stored grant is dead — `invalid_grant` on either the code exchange (the
 * authorization code is expired or already used) or a refresh (the refresh
 * token is expired, revoked, or already used), or a `401` from the REST API
 * (the access token was rejected), or no credential at all. The account must
 * complete the OAuth consent flow again; a plain retry won't fix it.
 */
export class MercadoPagoReauthRequiredError extends MercadoPagoError {
  constructor(
    readonly reason: 'no_token' | 'refresh_failed',
    message: string,
  ) {
    super(message);
    this.name = 'MercadoPagoReauthRequiredError';
  }
}

/** A network-level failure reaching Mercado Pago (fetch threw). */
export class MercadoPagoNetworkError extends MercadoPagoError {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MercadoPagoNetworkError';
  }
}
