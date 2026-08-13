/**
 * Map known Mercado Livre / context errors to HTTP responses. In a route's
 * catch, narrow with the `isMercadoLivreError` type guard (it only tests the
 * error; it does not throw) and pass the matched error here. The route's own
 * catch rethrows anything the guard rejects, so unrelated failures surface as
 * 500s instead of being swallowed. Mirrors apps/melhor-envio/lib/freight/respond.ts.
 */
import { NextResponse } from 'next/server';
import {
  MercadoLivreError,
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreNotConfiguredError,
  MercadoLivreReauthRequiredError,
  MercadoLivreValidationError,
} from '@delfrance/integrations-mercado-livre';

import {
  MercadoLivreConfigError,
  MercadoLivreContaNotConfiguredError,
  MercadoLivreNotImplementedError,
} from './mercadoLivre';

// `MercadoLivreError` is the base of every plugin error (HTTP / validation /
// network / reauth). `MercadoLivreNotConfiguredError` is the separate scaffold
// stub (extends `Error`, not `MercadoLivreError`), so it stays listed explicitly.
type KnownError =
  | MercadoLivreConfigError
  | MercadoLivreContaNotConfiguredError
  | MercadoLivreNotImplementedError
  | MercadoLivreNotConfiguredError
  | MercadoLivreError;

/** An ML error body is unbounded; a log line is not. Enough to identify it. */
const MAX_LOGGED_BODY = 500;

export function isMercadoLivreError(err: unknown): err is KnownError {
  return (
    err instanceof MercadoLivreConfigError ||
    err instanceof MercadoLivreContaNotConfiguredError ||
    err instanceof MercadoLivreNotImplementedError ||
    err instanceof MercadoLivreNotConfiguredError ||
    err instanceof MercadoLivreError
  );
}

/**
 * Map the error to its response, then LOG the reason before returning it.
 *
 * ⚠️ The logging is the load-bearing half. Every route funnels its known
 * failures through here and returns a JSON body the browser sees — but the
 * server terminal saw nothing at all, so an operator watching the dev server
 * (or Cloud Logging) read a bare `GET … 500` with no cause anywhere. The worst
 * case is the one that actually happened: `MERCADO_LIVRE_CLIENT_SECRET` missing
 * from the environment turns EVERY marketplace route into a silent 500, and the
 * only place naming the reason was a response body nobody was looking at.
 *
 * `verifyCaller` already logs its own two failure branches with a
 * `[mercado-livre/…]` prefix; this closes the other half of the same surface.
 */
export function mercadoLivreErrorResponse(err: KnownError): NextResponse {
  const res = toResponse(err);
  logErrorResponse(err, res.status);
  return res;
}

/**
 * One line per failed request, at a level matching whose fault it is: a 5xx is
 * ours (or ML's) and carries the error object so the stack survives; a 4xx is
 * the caller's and stays a warning.
 *
 * The extras are the fields that would otherwise be lost: an ML HTTP failure's
 * upstream status and body (the body is where ML explains itself), and a
 * validation failure's Zod issues (which field of the response changed shape).
 */
function logErrorResponse(err: KnownError, status: number): void {
  const detail =
    err instanceof MercadoLivreHttpError
      ? ` upstream=${String(err.status)} body=${safeJson(err.body)}`
      : err instanceof MercadoLivreValidationError
        ? ` issues=${safeJson(err.issues)}`
        : '';
  const line = `[mercado-livre/api] ${err.name} -> HTTP ${String(status)}: ${err.message}${detail}`;
  if (status >= 500) {
    console.error(line, err);
    return;
  }
  console.warn(line);
}

/**
 * Never let the logger itself throw, and never let it dump an unbounded ML body
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
  if (err instanceof MercadoLivreConfigError) {
    // Server misconfig (missing app credentials) — not the caller's fault.
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
  if (err instanceof MercadoLivreContaNotConfiguredError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof MercadoLivreReauthRequiredError) {
    // The stored grant is dead — the account must reconnect via OAuth.
    return NextResponse.json({ error: err.message, code: 'ML_REAUTH_REQUIRED' }, { status: 409 });
  }
  if (err instanceof MercadoLivreValidationError) {
    // ML returned an unexpected shape (a field changed) — upstream problem.
    return NextResponse.json({ error: err.message, code: 'ML_BAD_RESPONSE' }, { status: 502 });
  }
  if (err instanceof MercadoLivreHttpError) {
    return NextResponse.json(
      { error: err.message, code: 'ML_HTTP_ERROR', upstreamStatus: err.status },
      { status: 502 },
    );
  }
  if (err instanceof MercadoLivreNetworkError) {
    return NextResponse.json({ error: err.message, code: 'ML_NETWORK_ERROR' }, { status: 503 });
  }
  if (
    err instanceof MercadoLivreNotImplementedError ||
    err instanceof MercadoLivreNotConfiguredError
  ) {
    // Operation not wired yet.
    return NextResponse.json({ error: err.message, code: 'ML_NOT_IMPLEMENTED' }, { status: 501 });
  }
  // Any other MercadoLivreError subclass — generic upstream failure.
  return NextResponse.json({ error: err.message, code: 'ML_ERROR' }, { status: 500 });
}
