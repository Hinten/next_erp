/**
 * Typed errors for the Melhor Envio core. Callers branch on
 * `err instanceof <X>` (CLAUDE.md rule 6) — the apps/integrations route
 * layer maps these to HTTP status codes (e.g. ReauthRequired → 409).
 */

/** Base — every ME-originated failure is at least this. */
export class MelhorEnvioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MelhorEnvioError';
  }
}

/**
 * A non-2xx HTTP response from the ME API (other than the specialized
 * cases below). Carries the raw status + parsed/raw body for diagnostics.
 */
export class MelhorEnvioHttpError extends MelhorEnvioError {
  public readonly status: number;
  public readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'MelhorEnvioHttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * `422` — ME accepted the request shape but rejected its contents
 * (e.g. invalid CEP). `errors` is the field → messages map ME returns.
 */
export class MelhorEnvioValidationError extends MelhorEnvioError {
  public readonly errors: Record<string, string[]>;
  public readonly body: unknown;
  constructor(message: string, errors: Record<string, string[]>, body: unknown) {
    super(message);
    this.name = 'MelhorEnvioValidationError';
    this.errors = errors;
    this.body = body;
  }
}

/**
 * The account must be (re)connected via OAuth — there is no usable token.
 * Raised when:
 *  - no token doc exists yet (`reason: 'no_token'`), or
 *  - the refresh grant was rejected (`reason: 'refresh_failed'`) — ME
 *    refresh tokens expire after 45 days, after which only a fresh
 *    authorization-code flow recovers access.
 *
 * The route layer maps this to HTTP 409 `{ code: 'ME_REAUTH' }` so the
 * UI can prompt "reconecte a conta".
 */
export class MelhorEnvioReauthRequiredError extends MelhorEnvioError {
  public readonly reason: 'no_token' | 'refresh_failed';
  public readonly body: unknown;
  public readonly status: number | null;
  constructor(
    reason: 'no_token' | 'refresh_failed',
    message: string,
    body?: unknown,
    status: number | null = null,
  ) {
    super(message);
    this.name = 'MelhorEnvioReauthRequiredError';
    this.reason = reason;
    this.body = body;
    this.status = status;
  }
}

/**
 * A **200 whose body did not match the expected schema** — ME answered OK and we
 * cannot use the payload.
 *
 * Deliberately NOT `MelhorEnvioValidationError`: that one means ME's own `422`
 * field-errors payload and the route layer maps it to HTTP 422
 * (`apps/melhor-envio/lib/freight/respond.ts`). Conflating the two would turn a
 * broken upstream response into a "your input was invalid" 422.
 *
 * Before this existed, `oauth.ts` called `tokenResponseSchema.parse()` and a
 * malformed 200 escaped as a bare `ZodError` — which `isMelhorEnvioError` rejects,
 * so the OAuth callback rethrew it and the browser got an unhandled 500 instead of
 * a redirect it could explain.
 *
 * `issues` holds the Zod issues. ⚠️ Callers logging them must take PATHS and CODES
 * only: an issue can carry the inspected input, and on the token path that input is
 * a token response.
 */
export class MelhorEnvioSchemaError extends MelhorEnvioError {
  public readonly issues: unknown;
  public readonly body: unknown;
  constructor(message: string, issues: unknown, body: unknown) {
    super(message);
    this.name = 'MelhorEnvioSchemaError';
    this.issues = issues;
    this.body = body;
  }
}

/**
 * A network-level failure reaching Melhor Envio (fetch threw).
 *
 * Exists so a transport failure is distinguishable from "some other ME error":
 * it used to be raised as the bare `MelhorEnvioError` base, which is also what an
 * unmapped error looks like, so no caller could tell a dead network from an
 * unrecognised failure. Mirrors `FreightNetworkError` in `../http-client/errors`.
 */
export class MelhorEnvioNetworkError extends MelhorEnvioError {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MelhorEnvioNetworkError';
  }
}

/**
 * The label can't continue through the buy pipeline because Melhor Envio has
 * it in a terminal state — `canceled` or `suspended`. Re-buying requires a
 * fresh label (a new `printLabelId`); the route layer maps this to HTTP 409
 * so the UI can prompt the user to start over.
 */
export class MelhorEnvioLabelTerminalError extends MelhorEnvioError {
  public readonly reason: 'canceled' | 'suspended';
  constructor(reason: 'canceled' | 'suspended', message: string) {
    super(message);
    this.name = 'MelhorEnvioLabelTerminalError';
    this.reason = reason;
  }
}
