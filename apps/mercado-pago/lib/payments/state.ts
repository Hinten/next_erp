/**
 * Signed OAuth `state` for the Mercado Pago connect flow.
 *
 * `state` is `base64url(payload).base64url(HMAC-SHA256(payload))` keyed by
 * `MERCADO_PAGO_STATE_SECRET`; the public callback verifies the signature +
 * freshness before touching Firestore. Stateless — no nonce store needed (the
 * HMAC is the integrity guarantee, and it binds the `metodo_pgto` doc id so a
 * caller can't drive a callback for another account). Ported from
 * apps/mercado-livre/lib/marketplace/state.ts.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Max age of a signed state before the callback rejects it (10 min). */
const MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Tolerated forward clock skew. An `iat` further in the future than this is
 * rejected — otherwise a state minted by a fast/misconfigured clock would
 * outlive the 10-minute TTL (now − iat stays negative, never "> MAX_AGE_MS").
 */
const MAX_FUTURE_SKEW_MS = 60 * 1000;

export class PaymentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentStateError';
  }
}

interface StatePayload {
  readonly metodoId: string;
  readonly iat: number;
  readonly nonce: string;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** Mint a signed state binding `metodoId`, valid for {@link MAX_AGE_MS}. */
export function signState(metodoId: string, secret: string, now: number = Date.now()): string {
  const payload: StatePayload = { metodoId, iat: now, nonce: randomBytes(8).toString('hex') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a signed state and return its `metodoId`. Throws `PaymentStateError`
 * on a malformed, tampered, or expired value.
 */
export function verifyState(
  state: string,
  secret: string,
  now: number = Date.now(),
): { metodoId: string } {
  const dot = state.indexOf('.');
  if (dot <= 0) throw new PaymentStateError('state malformado');
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PaymentStateError('assinatura de state inválida');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) throw new PaymentStateError('payload de state inválido');
    throw err;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as StatePayload).metodoId !== 'string' ||
    typeof (parsed as StatePayload).iat !== 'number'
  ) {
    throw new PaymentStateError('payload de state inválido');
  }
  const payload = parsed as StatePayload;
  if (now - payload.iat > MAX_AGE_MS) {
    throw new PaymentStateError('state expirado');
  }
  if (payload.iat - now > MAX_FUTURE_SKEW_MS) {
    throw new PaymentStateError('state emitido no futuro');
  }
  return { metodoId: payload.metodoId };
}
