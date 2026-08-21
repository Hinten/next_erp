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
 *
 * ⚠️ `reason` is about the CREDENTIAL, not the grant type: `requestToken` raises
 * `'refresh_failed'` for an `invalid_grant` on a **code exchange** too, so it does
 * not tell you whether an authorization code or a refresh token died. The caller
 * knows which flow it started — infer it there, not from this field.
 *
 * `status`/`body` carry the ML response when there was one. They exist because
 * `invalid_grant` is the most common OAuth failure and dropping them left the
 * caller unable to tell an expired code from a `redirect_uri` mismatch (ML puts
 * that distinction in the body's `cause[]`). Both are null when the error is
 * raised without a response — e.g. `'no_token'`, where no request was made.
 */
export class MercadoLivreReauthRequiredError extends MercadoLivreError {
  constructor(
    readonly reason: 'no_token' | 'refresh_failed',
    message: string,
    readonly status: number | null = null,
    /** The parsed error body, when JSON; the raw text otherwise. */
    readonly body: unknown = null,
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

/**
 * A **409 version conflict** on a User-Products stock write (#706): the
 * `x-version` we echoed was no longer current, because something else moved the
 * stock between our read and our write — a sale, the ML panel, another
 * integrator.
 *
 * ⚠️ Deliberately a PREDICATE over `MercadoLivreHttpError`, not a class of its
 * own. The distinction is not about the error's shape (409 + a body is all ML
 * gives) but about the caller's response, and there is exactly one correct one:
 * re-read the stock for a fresh version and retry. A new class would have to be
 * raised inside the generic `toHttpError` mapper, which has no idea which
 * endpoint it is answering for — `PUT /items` also answers 409 ("item optimistic
 * locking error"), where the remedy is to wait, not to re-read a version.
 *
 * ⚠️ A caller must branch on this BEFORE any general `status >= 400 && < 500`
 * arm. A version conflict is the most ordinary thing that can happen to a
 * read-before-write, and falling into a terminal-4xx ladder would latch a
 * healthy listing as failed.
 */
export function isVersionConflict(err: unknown): err is MercadoLivreHttpError {
  return err instanceof MercadoLivreHttpError && err.status === 409;
}
