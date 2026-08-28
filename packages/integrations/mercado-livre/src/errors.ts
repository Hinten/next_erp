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

/** Which request failed — as much of it as is safe to keep. */
export interface MlRequestEndpoint {
  /** `'GET'`, `'POST'`, … */
  readonly method: string;
  /**
   * The URL's pathname, plus any {@link SAFE_QUERY_KEYS} it carried. Produced by
   * {@link sanitizeRequestPath} — never a raw URL.
   */
  readonly path: string;
}

/**
 * The only query keys whose VALUE may be kept, because on those endpoints the
 * pathname alone does not say which resource was asked for.
 *
 *  - `item_id` — `GET /users/{id}/shipping_options/free`
 *  - `ids` — the `GET /items` multiget
 *  - `shipment_ids` — `GET /shipment_labels`
 *
 * ⚠️ An ALLOWLIST, deliberately, and it is the whole security argument of this
 * field. The access token rides the `Authorization` header on every call in this
 * package — `api.ts` says so at each binary download: *"NEVER the legacy
 * `access_token` query param"* — so no URL here carries a secret today. This
 * list exists so that stays true if one ever does: a key nobody added is a key
 * nobody logs. #1015 is the worked example of a token reaching Cloud Logging
 * through an error field, and this field must not become the second one.
 *
 * A constant is not diagnostic, so `site_id` is deliberately absent: it is
 * always `'MLB'`.
 */
const SAFE_QUERY_KEYS = ['item_id', 'ids', 'shipment_ids'] as const;

/** A multiget `ids` can carry 20 MLB ids; a log line is not unbounded. */
const MAX_PATH_LENGTH = 200;

/**
 * The RAW, still-percent-encoded value of `key`, read out of the query STRING
 * rather than through `searchParams`.
 *
 * ⛔ `searchParams.get()` **decodes**, and this string is concatenated into a
 * Cloud Logging line. So a `%0A` inside an allowlisted id came back out as a real
 * newline and split one log entry into two, the second one fully attacker-shaped.
 * `parsed.pathname` never had that problem — `URL` does not decode it — so
 * reading raw here is what makes both halves of {@link sanitizeRequestPath} obey
 * ONE rule instead of two.
 *
 * ⚠️ Deliberately NOT `encodeURIComponent(searchParams.get(key))`. That also
 * re-encodes the commas in an `ids` multiget (`MLB1,MLB2` → `MLB1%2CMLB2`), and a
 * readable id list is the entire reason `ids` is allowlisted at all.
 */
function rawQueryValue(search: string, key: string): string | null {
  for (const pair of search.replace(/^\?/, '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1 ? pair !== key : pair.slice(0, eq) !== key) continue;
    return eq === -1 ? '' : pair.slice(eq + 1);
  }
  return null;
}

/**
 * A URL reduced to the part that is safe to log: pathname + allowlisted query.
 *
 * Returns null for anything unparseable rather than falling back to the raw
 * string — an input this cannot classify is exactly the input not to log.
 *
 * ⛔ **Nothing here is ever decoded**, so the result cannot carry a control
 * character and cannot forge a second log entry. Two things hold that together:
 * `URL` does not decode `pathname`, and {@link rawQueryValue} does not decode
 * the query. A LITERAL control character cannot arrive either — the WHATWG
 * parser strips tabs and newlines out of the input — which the tests ASSERT
 * rather than this defending against, so a runtime that stops doing it tells us.
 */
export function sanitizeRequestPath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    // `new URL` has one failure mode, and it is a TypeError. Anything else is
    // not ours to swallow (repo rule 6).
    if (err instanceof TypeError) return null;
    throw err;
  }
  const kept: string[] = [];
  for (const key of SAFE_QUERY_KEYS) {
    const value = rawQueryValue(parsed.search, key);
    if (value !== null && value !== '') kept.push(`${key}=${value}`);
  }
  const path = kept.length > 0 ? `${parsed.pathname}?${kept.join('&')}` : parsed.pathname;
  return path.length > MAX_PATH_LENGTH ? `${path.slice(0, MAX_PATH_LENGTH)}…` : path;
}

/** A non-2xx response from a Mercado Livre REST endpoint. */
export class MercadoLivreHttpError extends MercadoLivreError {
  /**
   * WHICH Mercado Livre call failed — null when the caller did not say.
   *
   * ⚠️ Without this, a generic ML 404 body (*"resource not found"*, the same
   * developers-site blurb for every unmatched route) is undiagnosable: the log
   * carries the status and the body and still cannot name the endpoint. Three
   * such 404s on `/importar` went unattributed for exactly that reason (#1347).
   *
   * Sanitised in the CONSTRUCTOR rather than by the caller, so no call site can
   * put a raw URL here by mistake.
   */
  readonly endpoint: MlRequestEndpoint | null;

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
    /**
     * The request as the caller issued it, RAW — `{ method, url }`. It is
     * reduced to {@link endpoint} here; the raw URL is never stored.
     */
    request: { method: string; url: string } | null = null,
  ) {
    super(message);
    this.name = 'MercadoLivreHttpError';
    const path = request == null ? null : sanitizeRequestPath(request.url);
    this.endpoint = request != null && path != null ? { method: request.method, path } : null;
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
