/**
 * Map known Melhor Envio / context errors to HTTP responses. In a route's
 * catch, narrow with the `isMelhorEnvioError` type guard (it only tests the
 * error; it does not throw) and pass the matched error here. The route's
 * own catch rethrows anything the guard rejects, so non-ME failures surface
 * as 500s instead of being swallowed.
 */
import { NextResponse } from 'next/server';
import {
  MelhorEnvioError,
  MelhorEnvioHttpError,
  MelhorEnvioReauthRequiredError,
  MelhorEnvioValidationError,
} from '@delfrance/integrations-freight-br';

import { MelhorEnvioContaNotConfiguredError } from './melhorEnvio';

export function isMelhorEnvioError(
  err: unknown,
): err is MelhorEnvioError | MelhorEnvioContaNotConfiguredError {
  return err instanceof MelhorEnvioError || err instanceof MelhorEnvioContaNotConfiguredError;
}

export function melhorEnvioErrorResponse(
  err: MelhorEnvioError | MelhorEnvioContaNotConfiguredError,
): NextResponse {
  if (err instanceof MelhorEnvioContaNotConfiguredError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof MelhorEnvioReauthRequiredError) {
    return NextResponse.json(
      { error: err.message, code: 'ME_REAUTH', reason: err.reason },
      { status: 409 },
    );
  }
  if (err instanceof MelhorEnvioValidationError) {
    return NextResponse.json({ error: err.message, errors: err.errors }, { status: 422 });
  }
  if (err instanceof MelhorEnvioHttpError) {
    // Upstream ME failure that isn't validation/reauth — surface as a bad
    // gateway so the client can distinguish it from its own 4xx.
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
  // Base MelhorEnvioError (e.g. a network failure reaching ME).
  return NextResponse.json({ error: err.message }, { status: 502 });
}
