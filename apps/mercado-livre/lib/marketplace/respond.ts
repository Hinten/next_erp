/**
 * Map known Mercado Livre / context errors to HTTP responses. In a route's
 * catch, narrow with the `isMercadoLivreError` type guard (it only tests the
 * error; it does not throw) and pass the matched error here. The route's own
 * catch rethrows anything the guard rejects, so unrelated failures surface as
 * 500s instead of being swallowed. Mirrors apps/melhor-envio/lib/freight/respond.ts.
 */
import { NextResponse } from 'next/server';
import { MercadoLivreNotConfiguredError } from '@delfrance/integrations-mercado-livre';

import {
  MercadoLivreConfigError,
  MercadoLivreContaNotConfiguredError,
  MercadoLivreNotImplementedError,
} from './mercadoLivre';

type KnownError =
  | MercadoLivreConfigError
  | MercadoLivreContaNotConfiguredError
  | MercadoLivreNotImplementedError
  | MercadoLivreNotConfiguredError;

export function isMercadoLivreError(err: unknown): err is KnownError {
  return (
    err instanceof MercadoLivreConfigError ||
    err instanceof MercadoLivreContaNotConfiguredError ||
    err instanceof MercadoLivreNotImplementedError ||
    err instanceof MercadoLivreNotConfiguredError
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
  // Both not-implemented shapes → 501 (the operation isn't wired yet, Phase 5).
  return NextResponse.json({ error: err.message, code: 'ML_NOT_IMPLEMENTED' }, { status: 501 });
}
