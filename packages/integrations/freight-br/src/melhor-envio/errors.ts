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
  constructor(reason: 'no_token' | 'refresh_failed', message: string, body?: unknown) {
    super(message);
    this.name = 'MelhorEnvioReauthRequiredError';
    this.reason = reason;
    this.body = body;
  }
}
