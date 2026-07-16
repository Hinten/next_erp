/**
 * Map known WhatsApp / context errors to HTTP responses. In a route's catch,
 * narrow with the `isWhatsappError` type guard (it only tests the error; it does
 * not throw) and pass the matched error here. The route's own catch rethrows
 * anything the guard rejects, so unrelated failures surface as 500s instead of
 * being swallowed. Mirrors apps/mercado-pago/lib/payments/respond.ts.
 *
 * All WhatsApp error classes are local to this app (the
 * `@delfrance/integrations-whatsapp-cloud-api` client throws plain `Error`s),
 * so — unlike the Mercado Pago mapper — there is no plugin error base to import.
 */
import { NextResponse } from 'next/server';

import {
  WhatsappConfigError,
  WhatsappContaNotConfiguredError,
  WhatsappGraphError,
  WhatsappTokenInvalidError,
  WhatsappTokenMissingError,
} from './whatsapp';

type KnownError =
  | WhatsappConfigError
  | WhatsappContaNotConfiguredError
  | WhatsappTokenMissingError
  | WhatsappTokenInvalidError
  | WhatsappGraphError;

export function isWhatsappError(err: unknown): err is KnownError {
  return (
    err instanceof WhatsappConfigError ||
    err instanceof WhatsappContaNotConfiguredError ||
    err instanceof WhatsappTokenMissingError ||
    err instanceof WhatsappTokenInvalidError ||
    err instanceof WhatsappGraphError
  );
}

export function whatsappErrorResponse(err: KnownError): NextResponse {
  if (err instanceof WhatsappConfigError) {
    // Server misconfig (missing app-wide config) — not the caller's fault.
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
  if (err instanceof WhatsappContaNotConfiguredError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof WhatsappTokenMissingError) {
    // No stored token — the account must reconnect; the panel shows "not connected".
    return NextResponse.json({ error: err.message, code: 'WA_REAUTH_REQUIRED' }, { status: 409 });
  }
  if (err instanceof WhatsappTokenInvalidError) {
    // Stored token was rejected by Graph — same reconnect semantics.
    return NextResponse.json({ error: err.message, code: 'WA_REAUTH_REQUIRED' }, { status: 409 });
  }
  // WhatsappGraphError — a non-auth upstream Graph failure.
  return NextResponse.json(
    { error: err.message, code: 'WA_GRAPH_ERROR', upstreamStatus: err.status },
    { status: 502 },
  );
}
