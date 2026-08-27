/**
 * Map known Mercado Pago / context errors to HTTP responses. In a route's
 * catch, narrow with the `isMercadoPagoError` type guard (it only tests the
 * error; it does not throw) and pass the matched error here. The route's own
 * catch rethrows anything the guard rejects, so unrelated failures surface as
 * 500s instead of being swallowed. Mirrors
 * apps/mercado-livre/lib/marketplace/core/respond.ts.
 */
import { NextResponse } from 'next/server';
import {
  MercadoPagoError,
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
  MercadoPagoValidationError,
} from '@delfrance/integrations-mercado-pago';

import { MercadoPagoConfigError, MercadoPagoContaNotConfiguredError } from './mercadoPago';

// `MercadoPagoError` is the base of every plugin error (HTTP / validation /
// network / reauth). The two context errors extend `Error`, not
// `MercadoPagoError`, so they stay listed explicitly.
type KnownError = MercadoPagoConfigError | MercadoPagoContaNotConfiguredError | MercadoPagoError;

export function isMercadoPagoError(err: unknown): err is KnownError {
  return (
    err instanceof MercadoPagoConfigError ||
    err instanceof MercadoPagoContaNotConfiguredError ||
    err instanceof MercadoPagoError
  );
}

export function mercadoPagoErrorResponse(err: KnownError): NextResponse {
  if (err instanceof MercadoPagoConfigError) {
    // Server misconfig (missing app credentials) — not the caller's fault.
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
  if (err instanceof MercadoPagoContaNotConfiguredError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof MercadoPagoReauthRequiredError) {
    // The stored grant is dead — the account must reconnect via OAuth.
    return NextResponse.json({ error: err.message, code: 'MP_REAUTH_REQUIRED' }, { status: 409 });
  }
  if (err instanceof MercadoPagoValidationError) {
    // MP returned an unexpected shape (a field changed) — upstream problem.
    return NextResponse.json({ error: err.message, code: 'MP_BAD_RESPONSE' }, { status: 502 });
  }
  if (err instanceof MercadoPagoHttpError) {
    return NextResponse.json(
      { error: err.message, code: 'MP_HTTP_ERROR', upstreamStatus: err.status },
      { status: 502 },
    );
  }
  if (err instanceof MercadoPagoNetworkError) {
    return NextResponse.json({ error: err.message, code: 'MP_NETWORK_ERROR' }, { status: 503 });
  }
  // Any other MercadoPagoError subclass — generic upstream failure.
  return NextResponse.json({ error: err.message, code: 'MP_ERROR' }, { status: 500 });
}
