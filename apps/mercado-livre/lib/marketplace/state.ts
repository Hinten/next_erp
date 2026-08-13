/**
 * Signed OAuth `state` for the Mercado Livre connect flow.
 *
 * The legacy Flutter app put the **raw** integração doc id in `state`, so any
 * caller could drive a callback for any account. Here `state` is
 * `base64url(payload).base64url(HMAC-SHA256(payload))` keyed by
 * `MERCADO_LIVRE_STATE_SECRET`; the public callback verifies the signature +
 * freshness before touching Firestore. Ported from
 * apps/melhor-envio/lib/freight/state.ts.
 *
 * ⚠️ The HMAC proves INTEGRITY, not freshness-of-use — a captured `state` used
 * to be replayable for the whole {@link MAX_AGE_MS} window (#821/T3). Signing is
 * therefore only half the anchor: the `nonce` this module mints is now RETURNED
 * to the caller and recorded server-side, and the callback consumes that record
 * exactly once (`oauthStateStore.ts`). Keep the two in step — a `nonce` that
 * nothing stores is a guard that never rejects anything.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Max age of a signed state before the callback rejects it (10 min). Exported
 * so the stored record ages out on exactly the same clock — two windows that
 * can drift apart would leave one of them dead code.
 */
export const MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Tolerance for a state minted slightly in the future — clock skew between the
 * App Hosting instance that signed it and the one that verifies it. Without an
 * upper bound, a forward-dated `iat` would never expire. Mirrors
 * apps/mercado-pago/lib/payments/state.ts.
 */
const MAX_FUTURE_SKEW_MS = 60 * 1000;

export class MarketplaceStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketplaceStateError';
  }
}

interface StatePayload {
  readonly integracaoId: string;
  readonly iat: number;
  readonly nonce: string;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * Mint a signed state binding `integracaoId`, valid for {@link MAX_AGE_MS}.
 *
 * Returns the `nonce` alongside the state: the caller MUST persist it (see
 * `putOauthState`) or the callback has nothing to consume and the state stays
 * replayable for the whole window.
 */
export function signState(
  integracaoId: string,
  secret: string,
  now: number = Date.now(),
): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString('hex');
  const payload: StatePayload = { integracaoId, iat: now, nonce };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { state: `${body}.${sign(body, secret)}`, nonce };
}

/**
 * Verify a signed state and return its `integracaoId` + `nonce`. Throws
 * `MarketplaceStateError` on a malformed, tampered, or expired value.
 *
 * A successful return proves the state was minted by us and is still fresh — it
 * does NOT prove the state is unused. The caller must consume the `nonce`'s
 * stored record to rule out a replay.
 */
export function verifyState(
  state: string,
  secret: string,
  now: number = Date.now(),
): { integracaoId: string; nonce: string } {
  const dot = state.indexOf('.');
  if (dot <= 0) throw new MarketplaceStateError('state malformado');
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new MarketplaceStateError('assinatura de state inválida');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) throw new MarketplaceStateError('payload de state inválido');
    throw err;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as StatePayload).integracaoId !== 'string' ||
    typeof (parsed as StatePayload).iat !== 'number' ||
    typeof (parsed as StatePayload).nonce !== 'string' ||
    (parsed as StatePayload).nonce.length === 0
  ) {
    throw new MarketplaceStateError('payload de state inválido');
  }
  const payload = parsed as StatePayload;
  if (payload.iat - now > MAX_FUTURE_SKEW_MS) {
    throw new MarketplaceStateError('state emitido no futuro');
  }
  if (now - payload.iat > MAX_AGE_MS) {
    throw new MarketplaceStateError('state expirado');
  }
  return { integracaoId: payload.integracaoId, nonce: payload.nonce };
}
