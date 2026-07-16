/**
 * Map known WhatsApp / context errors to HTTP responses. In a route's catch,
 * narrow with the `isWhatsappError` type guard (it only tests the error; it does
 * not throw) and pass the matched error here. The route's own catch rethrows
 * anything the guard rejects, so unrelated failures surface as 500s instead of
 * being swallowed. Mirrors apps/mercado-pago/lib/payments/respond.ts.
 *
 * Two error families flow here: the app-local context errors (`Whatsapp*Error`,
 * defined in `./whatsapp`) AND the two typed errors the
 * `@delfrance/integrations-whatsapp-cloud-api` client throws for the
 * PIN/verify/register/status Graph calls (`WhatsAppHttpError` /
 * `WhatsAppNetworkError`). The latter carry the RESPONSE body only (never the
 * request), so mapping their body for a Graph `error.code` / `error_user_msg`
 * never risks echoing a pin or bearer token.
 */
import { NextResponse } from 'next/server';
import {
  WhatsAppHttpError,
  WhatsAppNetworkError,
} from '@delfrance/integrations-whatsapp-cloud-api';

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
  | WhatsappGraphError
  | WhatsAppHttpError
  | WhatsAppNetworkError;

export function isWhatsappError(err: unknown): err is KnownError {
  return (
    err instanceof WhatsappConfigError ||
    err instanceof WhatsappContaNotConfiguredError ||
    err instanceof WhatsappTokenMissingError ||
    err instanceof WhatsappTokenInvalidError ||
    err instanceof WhatsappGraphError ||
    err instanceof WhatsAppHttpError ||
    err instanceof WhatsAppNetworkError
  );
}

/** Graph invalid/expired-token error code (mirrors `whatsapp.ts`). */
const GRAPH_INVALID_TOKEN_CODE = 190;
/** Graph register rate-limit — the register endpoint's 10-attempts-per-72h cap. */
const GRAPH_REGISTER_CAP_CODE = 133016;

/** The fields we read off a Graph error response body (best-effort). */
interface GraphErrorBody {
  code: number | null;
  message: string | null;
  userMsg: string | null;
}

/**
 * Extract `error.code` / `error.message` / `error.error_user_msg` from a Graph
 * error RESPONSE body snippet. The snippet may be truncated (500-char cap) or
 * non-JSON — a parse failure degrades to all-null rather than throwing.
 */
function parseGraphErrorBody(body: string): GraphErrorBody {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; message?: unknown; error_user_msg?: unknown };
    };
    const e = parsed.error;
    return {
      code: typeof e?.code === 'number' ? e.code : null,
      message: typeof e?.message === 'string' ? e.message : null,
      userMsg: typeof e?.error_user_msg === 'string' ? e.error_user_msg : null,
    };
  } catch (err) {
    if (err instanceof SyntaxError) return { code: null, message: null, userMsg: null };
    throw err;
  }
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
  if (err instanceof WhatsappGraphError) {
    // App-local non-auth upstream Graph failure (the `conta` phone probe).
    return NextResponse.json(
      { error: err.message, code: 'WA_GRAPH_ERROR', upstreamStatus: err.status },
      { status: 502 },
    );
  }
  if (err instanceof WhatsAppNetworkError) {
    // Transport-level failure reaching Graph — nothing the caller can fix.
    return NextResponse.json(
      { error: 'Falha de rede ao comunicar com o WhatsApp Cloud API.', code: 'WA_GRAPH_ERROR' },
      { status: 502 },
    );
  }
  // WhatsAppHttpError — a non-2xx (or unusable-2xx) Graph response from the
  // PIN/verify/register/status client calls. Map by upstream status + Graph
  // error code.
  const graph = parseGraphErrorBody(err.body);
  if (err.status === 401 || graph.code === GRAPH_INVALID_TOKEN_CODE) {
    // Token dead/expired — reconnect (same semantics as the context errors).
    return NextResponse.json(
      {
        error: graph.userMsg ?? graph.message ?? 'Token inválido — reconecte.',
        code: 'WA_REAUTH_REQUIRED',
      },
      { status: 409 },
    );
  }
  if (graph.code === GRAPH_REGISTER_CAP_CODE) {
    // Register cap (10 attempts / 72h) — a rate limit, not the caller's fault now.
    return NextResponse.json(
      {
        error:
          graph.userMsg ??
          graph.message ??
          'Limite de tentativas de registro atingido (10 a cada 72h). Tente novamente mais tarde.',
        code: 'WA_RATE_LIMIT',
      },
      { status: 429 },
    );
  }
  if (err.status === 400) {
    // Bad request — surface the operator-facing message when Graph gives one.
    return NextResponse.json(
      { error: graph.userMsg ?? graph.message ?? err.message },
      { status: 400 },
    );
  }
  // Any other upstream HTTP status — an upstream Graph failure.
  return NextResponse.json(
    {
      error: graph.userMsg ?? graph.message ?? err.message,
      code: 'WA_GRAPH_ERROR',
      upstreamStatus: err.status,
    },
    { status: 502 },
  );
}
