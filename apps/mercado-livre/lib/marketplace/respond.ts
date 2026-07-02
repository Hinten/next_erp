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

export function isMercadoLivreError(err: unknown): err is KnownError {
  return (
    err instanceof MercadoLivreConfigError ||
    err instanceof MercadoLivreContaNotConfiguredError ||
    err instanceof MercadoLivreNotImplementedError ||
    err instanceof MercadoLivreNotConfiguredError ||
    err instanceof MercadoLivreError
  );
}

export function mercadoLivreErrorResponse(err: KnownError): NextResponse {
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
