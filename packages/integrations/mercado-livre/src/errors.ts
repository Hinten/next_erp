/**
 * Typed error hierarchy for the Mercado Livre integration. Every `catch` in
 * this package narrows on one of these (or a known platform error) and rethrows
 * anything else — no generic catch (repo rule). Callers branch on `instanceof`
 * to map to HTTP responses / re-auth prompts.
 */

/** Base class for every error this package raises. */
export class MercadoLivreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MercadoLivreError';
  }
}

/** A non-2xx response from a Mercado Livre REST endpoint. */
export class MercadoLivreHttpError extends MercadoLivreError {
  constructor(
    message: string,
    readonly status: number,
    /** The parsed error body, when JSON; the raw text otherwise. */
    readonly body: unknown,
    /**
     * The response's `Retry-After` header in whole seconds, when present and
     * numeric (429 rate limits) — null otherwise. Callers honour it when
     * scheduling a pause instead of a fixed default.
     */
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = 'MercadoLivreHttpError';
  }
}

/** A response that did not match the expected Zod schema (ML changed a field). */
export class MercadoLivreValidationError extends MercadoLivreError {
  constructor(
    message: string,
    readonly issues: unknown,
  ) {
    super(message);
    this.name = 'MercadoLivreValidationError';
  }
}

/**
 * The stored grant is dead — `invalid_grant` on either the code exchange (the
 * authorization code is expired or already used) or a refresh (the refresh
 * token is expired, revoked, or already used), or no credential at all. The
 * account must complete the OAuth consent flow again; a plain retry won't fix it.
 */
export class MercadoLivreReauthRequiredError extends MercadoLivreError {
  constructor(
    readonly reason: 'no_token' | 'refresh_failed',
    message: string,
  ) {
    super(message);
    this.name = 'MercadoLivreReauthRequiredError';
  }
}

/** A network-level failure reaching Mercado Livre (fetch threw). */
export class MercadoLivreNetworkError extends MercadoLivreError {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MercadoLivreNetworkError';
  }
}

/**
 * `shipment_labels` refused to emit the label: a 400 with a `failed_shipments`
 * body (e.g. substatus `invoice_pending` until the NF-e is uploaded), or a 2xx
 * with an empty body (legacy guard). Distinct from `MercadoLivreHttpError` so
 * the route can branch on the ML reason instead of a generic HTTP failure.
 */
export class MercadoLivreLabelUnavailableError extends MercadoLivreError {
  constructor(
    message: string,
    /**
     * The raw `failed_shipments[0].message`, in FULL — callers substring-match
     * `invoice_pending` on it (legacy parity). `''` on the empty-body case.
     */
    readonly mlMessage: string,
  ) {
    super(message);
    this.name = 'MercadoLivreLabelUnavailableError';
  }
}
