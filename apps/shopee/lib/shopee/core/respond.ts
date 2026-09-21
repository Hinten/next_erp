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
 * not cosmetic. `ShopeeConfigError`, `ShopeeSchemaError`, `ShopeeNetworkError`,
 * `ShopeeHttpError`, (since step 9) `ShopeeImportBlockedError` and (since step
 * 11) `ShopeePublishBlockedError` + `ShopeePublishRejectedError` all extend
 * `ShopeeError` **directly** — they are NOT `ShopeeApiError` subclasses — while
 * `ShopeeReauthRequiredError` and `ShopeeRateLimitError` are. Testing the base
 * class first would collapse eight distinct diagnoses into one 500.
 *
 * The three PER-ITEM refusals — one import, two publish — sit together at the
 * bottom of the chain and all three above the base `ShopeeError` arm.
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

import { ShopeePublishBlockedError, ShopeePublishRejectedError } from '../anuncios/errosPublicacao';
import { ShopeeImportBlockedError } from '../produtos/errosImportacao';
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
 *
 * ⚠️ The THREE per-item refusals are the exception to that sentence:
 * `ShopeeImportBlockedError` (step 9) and `ShopeePublishBlockedError` /
 * `ShopeePublishRejectedError` (step 11) DO extend `ShopeeError`, so the base
 * arm already answers the boolean for them. They join this union anyway — not
 * for the guard, but so `toResponse` can read `err.motivo` / `err.etapa` /
 * `err.problemas` without a cast. The import runs ONE way (`respond.ts` →
 * `produtos/`, `anuncios/`): every module under those folders is Next-free
 * because the Cloud Functions bundle reaches them, and this file imports
 * `next/server`.
 */
type KnownError =
  | ShopeeContaNotConfiguredError
  | ShopeeCredencialInvalidaError
  | ShopeeSemCredencialError
  | ShopeeContaSemShopIdError
  | ShopeeRefreshEmAndamentoError
  | ShopeeImportBlockedError
  | ShopeePublishBlockedError
  | ShopeePublishRejectedError
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
    // Redundant with the base arm below (it extends `ShopeeError`) and named
    // anyway: this guard is the list a reader consults to answer "does the route
    // handle it?", and the answer for a blocked import must not depend on
    // noticing which base class it happens to extend.
    err instanceof ShopeeImportBlockedError ||
    err instanceof ShopeePublishBlockedError ||
    err instanceof ShopeePublishRejectedError ||
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
  if (err instanceof ShopeePublishBlockedError) {
    // ⚠️ ABOVE the base `ShopeeError` arm it extends, for the reason spelled out
    // on the import arm below: a per-PRODUTO refusal reported as `SHOPEE_ERROR`
    // 500 reads as OUR outage, and the operator would never learn which produto
    // was refused or which field refused it. 422 and not 400: the request is
    // well-formed and may be retried unchanged once the cause is fixed (a weight
    // filled in, a mandatory attribute answered).
    //
    // ⚠️ NOTHING was sent to Shopee for this produto — that is the contract this
    // class carries, and it is what lets the caller retry from a clean state.
    // `problemas[].mensagem` is a MECHANISM sentence, capped at construction
    // (see the class docblock); the body says nothing the error does not.
    return NextResponse.json(
      {
        error: err.message,
        code: 'SHOPEE_PUBLISH_BLOCKED',
        motivo: err.motivo,
        produtoId: err.produtoId,
        itemId: err.itemId,
        problemas: err.problemas,
      },
      { status: 422 },
    );
  }
  if (err instanceof ShopeePublishRejectedError) {
    // The post-write twin: Shopee refused a call and the refusal was classified
    // onto request fields. `etapa` is the load-bearing extra — it says what
    // exists on the channel NOW (a rejection at `init_tier_variation` leaves an
    // UNLIST item with no models), which no HTTP status can carry.
    //
    // ⚠️ `shopeeCode` is Shopee's own string VERBATIM, prefix and all, exactly as
    // the `ShopeeApiError` arm reports its `code`. The stripped form is a
    // classification detail and never leaves the classifier.
    return NextResponse.json(
      {
        error: err.message,
        code: 'SHOPEE_PUBLISH_REJECTED',
        etapa: err.etapa,
        shopeeCode: err.shopeeCode,
        produtoId: err.produtoId,
        itemId: err.itemId,
        problemas: err.problemas,
      },
      { status: 422 },
    );
  }
  if (err instanceof ShopeeImportBlockedError) {
    // ⚠️ IMMEDIATELY ABOVE the base `ShopeeError` arm it extends — below it, a
    // per-ITEM refusal would be reported as `SHOPEE_ERROR` 500, i.e. as OUR
    // outage, and the operator would never be told which listing was refused or
    // why. 422 and not 400: the request is well-formed and the caller may retry
    // it unchanged once the cause is fixed (a kit component imported, a name
    // filled in on Shopee).
    //
    // ⚠️ `mensagem` is a MECHANISM sentence by construction — never a listing
    // name, a description, a URL or a response body (see the class docblock).
    // The body says nothing more than the error already carries.
    return NextResponse.json(
      {
        error: err.message,
        code: 'SHOPEE_IMPORT_BLOCKED',
        motivo: err.motivo,
        itemId: err.itemId,
        mensagem: err.mensagem,
      },
      { status: 422 },
    );
  }
  // Any other ShopeeError subclass — generic upstream failure.
  return NextResponse.json({ error: err.message, code: 'SHOPEE_ERROR' }, { status: 500 });
}
