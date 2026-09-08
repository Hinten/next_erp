/**
 * Map known Shopee / context errors to HTTP responses. In a route's catch,
 * narrow with the {@link isShopeeError} type guard (it only tests the error; it
 * does not throw) and pass the matched error here. The route's own catch
 * rethrows anything the guard rejects, so unrelated failures surface as 500s
 * instead of being swallowed (root CLAUDE.md rule 6).
 *
 * Mirrors `apps/mercado-livre/lib/marketplace/core/respond.ts`.
 *
 * ⚠️ The `instanceof` chain runs MOST-DERIVED FIRST, and on this channel that is
 * not cosmetic. `ShopeeConfigError`, `ShopeeSchemaError`, `ShopeeNetworkError`
 * and `ShopeeHttpError` all extend `ShopeeError` **directly** — they are NOT
 * `ShopeeApiError` subclasses — while `ShopeeReauthRequiredError` and
 * `ShopeeRateLimitError` are. Testing the base class first would collapse five
 * distinct diagnoses into one 500.
 */
import { NextResponse } from 'next/server';
import {
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';

import { ShopeeCredencialInvalidaError } from './credentialStore';
import { ShopeeContaNotConfiguredError } from './shopee';
import {
  ShopeeContaSemShopIdError,
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
} from './tokenStore';

/**
 * ⚠️ FIVE of these are NOT `ShopeeError` subclasses — they are this app's own
 * classes — so the guard has to name each one explicitly, and an app-local class
 * forgotten here falls past the route catch and 500s. `ShopeeConfigError` IS one
 * (re-exported by `../env`), which is exactly why there is a single class rather
 * than an app-local copy.
 */
type KnownError =
  | ShopeeContaNotConfiguredError
  | ShopeeCredencialInvalidaError
  | ShopeeSemCredencialError
  | ShopeeContaSemShopIdError
  | ShopeeRefreshEmAndamentoError
  | ShopeeError;

/** A Shopee body is unbounded; a log line is not. Enough to identify it. */
const MAX_LOGGED_BODY = 500;

export function isShopeeError(err: unknown): err is KnownError {
  return (
    err instanceof ShopeeContaNotConfiguredError ||
    err instanceof ShopeeCredencialInvalidaError ||
    err instanceof ShopeeSemCredencialError ||
    err instanceof ShopeeContaSemShopIdError ||
    err instanceof ShopeeRefreshEmAndamentoError ||
    err instanceof ShopeeError
  );
}

/**
 * Map the error to its response, then LOG the reason before returning it.
 *
 * ⚠️ The logging is the load-bearing half. Without it a missing
 * `SHOPEE_PARTNER_KEY` turns EVERY route into a silent 500 whose only
 * explanation sits in a response body nobody is watching — the failure mode
 * `mercadoLivreErrorResponse` was written to end.
 */
export function shopeeErrorResponse(err: KnownError): NextResponse {
  const res = toResponse(err);
  logErrorResponse(err, res.status);
  return res;
}

/**
 * One line per failed request, at a level matching whose fault it is: a 5xx is
 * ours (or Shopee's) and carries the error object so the stack survives; a 4xx
 * is the caller's and stays a warning.
 *
 * ⚠️ Field PATHS for a schema failure, never the body. On this channel the body
 * behind a schema failure can BE the token response (#1015).
 */
function logErrorResponse(err: KnownError, status: number): void {
  const detail =
    err instanceof ShopeeApiError
      ? ` path=${err.path} code=${err.code} kind=${err.kind} upstream=${String(err.httpStatus)}`
      : err instanceof ShopeeSchemaError
        ? ` path=${err.path} campos=${safeJson(err.campos)}`
        : err instanceof ShopeeCredencialInvalidaError
          ? ` campos=${safeJson(err.campos)}`
          : err instanceof ShopeeHttpError
            ? ` path=${err.path} upstream=${String(err.httpStatus)}`
            : '';
  const line = `[shopee/api] ${err.name} -> HTTP ${String(status)}: ${err.message}${detail}`;
  if (status >= 500) {
    console.error(line, err);
    return;
  }
  console.warn(line);
}

/**
 * Never let the logger itself throw, and never let it dump an unbounded payload
 * into the log stream.
 *
 * `JSON.stringify` has exactly two failure modes and both are `TypeError` — a
 * circular structure and a `BigInt` — so the narrowing is complete rather than
 * merely convenient. Anything else rethrows (root CLAUDE.md rule 6).
 */
function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    // `undefined` in, `undefined` out — stringify returns no string at all.
    if (json == null) return String(value);
    return json.length > MAX_LOGGED_BODY ? `${json.slice(0, MAX_LOGGED_BODY)}…` : json;
  } catch (err) {
    if (err instanceof TypeError) return '[unserializable]';
    throw err;
  }
}

function toResponse(err: KnownError): NextResponse {
  if (err instanceof ShopeeConfigError) {
    // Server misconfig (a missing partner id/key, a bad host override) — not
    // the caller's fault.
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
  if (err instanceof ShopeeContaNotConfiguredError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof ShopeeRefreshEmAndamentoError) {
    // Transient by construction: another instance holds the refresh lease and
    // the very next call almost certainly finds the fresh pair. `Retry-After: 1`
    // is a second because the whole race is one provider round trip wide, and
    // the lease that bounds it expires in `REFRESH_LEASE_TTL_MS`.
    return NextResponse.json(
      {
        error: err.message,
        code: 'SHOPEE_REFRESH_EM_ANDAMENTO',
        leaseExpiraEm: err.leaseExpiraEm,
      },
      { status: 503, headers: { 'Retry-After': '1' } },
    );
  }
  if (err instanceof ShopeeSemCredencialError) {
    // Nothing stored, or nothing usable — only a new consent fixes it. Same
    // code as a dead grant: from the operator's side the action is identical.
    return NextResponse.json(
      { error: err.message, code: 'SHOPEE_REAUTH_REQUIRED' },
      { status: 409 },
    );
  }
  if (err instanceof ShopeeContaSemShopIdError) {
    // A connected conta with a main-account-scoped consent. Its own code: the
    // fix is the shop fan-out, never a reconnect, and telling the operator to
    // reconnect would send them round a loop that cannot help.
    return NextResponse.json(
      { error: err.message, code: 'SHOPEE_CONTA_SEM_SHOP_ID' },
      { status: 409 },
    );
  }
  if (err instanceof ShopeeCredencialInvalidaError) {
    return NextResponse.json(
      { error: err.message, code: 'SHOPEE_BAD_RESPONSE', campos: err.campos },
      { status: 502 },
    );
  }
  if (err instanceof ShopeeSchemaError) {
    // Shopee returned an unexpected shape (a field changed) — upstream problem.
    return NextResponse.json(
      { error: err.message, code: 'SHOPEE_BAD_RESPONSE', campos: err.campos },
      { status: 502 },
    );
  }
  if (err instanceof ShopeeReauthRequiredError) {
    // ⚠️ ABOVE the `ShopeeApiError` arm it extends, or a dead grant would be
    // reported as a generic 502 upstream failure and the operator would never
    // be told to reconnect (ML parity — `ML_REAUTH_REQUIRED`).
    return NextResponse.json(
      { error: err.message, code: 'SHOPEE_REAUTH_REQUIRED', shopeeCode: err.code },
      { status: 409 },
    );
  }
  if (err instanceof ShopeeApiError) {
    // ⚠️ `upstreamStatus` is diagnostics only: a FAILING Shopee call is
    // routinely HTTP 200, so it is `error`/`kind` that carry the verdict.
    return NextResponse.json(
      {
        error: err.message,
        code: 'SHOPEE_HTTP_ERROR',
        upstreamStatus: err.httpStatus,
        shopeeCode: err.code,
        kind: err.kind,
      },
      { status: 502 },
    );
  }
  if (err instanceof ShopeeNetworkError) {
    return NextResponse.json({ error: err.message, code: 'SHOPEE_NETWORK_ERROR' }, { status: 503 });
  }
  if (err instanceof ShopeeHttpError) {
    // A non-2xx whose body is not an envelope — under the coming IP allow-list
    // this is an EDGE rejection, not an API failure.
    return NextResponse.json(
      { error: err.message, code: 'SHOPEE_HTTP_ERROR', upstreamStatus: err.httpStatus },
      { status: 502 },
    );
  }
  // Any other ShopeeError subclass — generic upstream failure.
  return NextResponse.json({ error: err.message, code: 'SHOPEE_ERROR' }, { status: 500 });
}
