/**
 * Signed OAuth `state` for the Melhor Envio connect flow.
 *
 * The legacy Flutter app put the **raw** integração doc id in `state`
 * (`api.dart:137`), so any caller could drive a callback for any account.
 * Here `state` is `base64url(payload).base64url(HMAC-SHA256(payload))`
 * keyed by `MELHOR_ENVIO_STATE_SECRET`; the callback verifies the
 * signature + freshness before touching Firestore. Stateless — no nonce
 * store needed (the HMAC is the integrity guarantee).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Max age of a signed state before the callback rejects it (10 min). */
const MAX_AGE_MS = 10 * 60 * 1000;

export class FreightStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreightStateError';
  }
}

interface StatePayload {
  readonly intFreteId: string;
  readonly iat: number;
  readonly nonce: string;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** Mint a signed state binding `intFreteId`, valid for {@link MAX_AGE_MS}. */
export function signState(intFreteId: string, secret: string, now: number = Date.now()): string {
  const payload: StatePayload = { intFreteId, iat: now, nonce: randomBytes(8).toString('hex') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a signed state and return its `intFreteId`. Throws
 * `FreightStateError` on a malformed, tampered, or expired value.
 */
export function verifyState(
  state: string,
  secret: string,
  now: number = Date.now(),
): { intFreteId: string } {
  const dot = state.indexOf('.');
  if (dot <= 0) throw new FreightStateError('state malformado');
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new FreightStateError('assinatura de state inválida');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) throw new FreightStateError('payload de state inválido');
    throw err;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as StatePayload).intFreteId !== 'string' ||
    typeof (parsed as StatePayload).iat !== 'number'
  ) {
    throw new FreightStateError('payload de state inválido');
  }
  const payload = parsed as StatePayload;
  if (now - payload.iat > MAX_AGE_MS) {
    throw new FreightStateError('state expirado');
  }
  return { intFreteId: payload.intFreteId };
}
