/**
 * Signed OAuth `state` shared by every channel that runs an authorization-code
 * connect flow — Mercado Livre, Melhor Envio, Mercado Pago (#821, #1034).
 *
 * `state` is `base64url(payload).base64url(HMAC-SHA256(payload))` keyed by that
 * channel's own `*_STATE_SECRET`; the public callback verifies the signature +
 * freshness before touching Firestore. The legacy Flutter app put the **raw**
 * account doc id in `state`, so any caller could drive a callback for any
 * account — the HMAC is what closed that.
 *
 * ⚠️ The HMAC proves INTEGRITY, not freshness-of-use. A captured `state` used to
 * be replayable for the whole {@link MAX_AGE_MS} window on every channel, and a
 * replay OVERWROTE the account's stored credential with whoever drove the second
 * callback. Signing is therefore only half the anchor: the `nonce` minted here is
 * RETURNED to the caller, recorded server-side, and redeemed exactly once by
 * `createOauthStateStore` (`./store.ts`). Keep the two in step — a `nonce` that
 * nothing stores is a guard that never rejects anything.
 *
 * ℹ️ This module is pure (`node:crypto`, no Firestore) but deliberately lives
 * under `src/admin/` rather than in `@delfrance/core`. Core carries no
 * `@types/node` on purpose — it is browser-targeted, and its root-barrel test
 * exists to keep it that way — whereas everything under `admin/` is already
 * server-only by contract (see `adminBundleSafety.test.ts`). Keeping both halves
 * of the guarantee in one place beats splitting them across two packages to
 * satisfy a boundary neither half belongs on the far side of.
 *
 * ⚠️ This replaced three hand-copied per-app copies. The drift that motivated the
 * extraction was real and silent: {@link MAX_FUTURE_SKEW_MS} existed in exactly
 * one of the three for months. Add behaviour HERE, never in a channel.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Max age of a signed state before the callback rejects it (10 min). Exported so
 * the stored attempt record ages out on exactly the same clock — two windows that
 * can drift apart would leave one of them dead code.
 */
export const MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Tolerance for a state minted slightly in the future — clock skew between the
 * App Hosting instance that signed it and the one that verifies it. Without an
 * upper bound a forward-dated `iat` would NEVER expire, because `now - iat` stays
 * negative and can never exceed {@link MAX_AGE_MS}.
 */
export const MAX_FUTURE_SKEW_MS = 60 * 1000;

/** A malformed, tampered, expired, superseded or already-used `state`. */
export class OauthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OauthStateError';
  }
}

/**
 * The signed payload.
 *
 * `id` is the account doc id the callback is authorized to act on — an
 * `integracao`, an `int_frete` or a `metodo_pgto` depending on the channel. It is
 * a single neutral key rather than a per-channel one (`integracaoId` /
 * `intFreteId` / `metodoId`) so one implementation serves all three; each callback
 * renames it at its own boundary.
 */
interface StatePayload {
  readonly id: string;
  readonly iat: number;
  readonly nonce: string;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * Mint a signed state binding `id`, valid for {@link MAX_AGE_MS}.
 *
 * Returns the `nonce` alongside the state: the caller MUST persist it (see the
 * store's `put`) or the callback has nothing to redeem and the state stays
 * replayable for the whole window.
 */
export function signState(
  id: string,
  secret: string,
  now: number = Date.now(),
): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString('hex');
  const payload: StatePayload = { id, iat: now, nonce };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { state: `${body}.${sign(body, secret)}`, nonce };
}

/**
 * Verify a signed state and return its `id` + `nonce`. Throws
 * {@link OauthStateError} on a malformed, tampered, expired or future-dated value.
 *
 * A successful return proves the state was minted by us and is still fresh — it
 * does NOT prove the state is unused. The caller must redeem the `nonce`'s stored
 * record to rule out a replay.
 */
export function verifyState(
  state: string,
  secret: string,
  now: number = Date.now(),
): { id: string; nonce: string } {
  const dot = state.indexOf('.');
  if (dot <= 0) throw new OauthStateError('state malformado');
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new OauthStateError('assinatura de state inválida');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) throw new OauthStateError('payload de state inválido');
    throw err;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as StatePayload).id !== 'string' ||
    (parsed as StatePayload).id.length === 0 ||
    typeof (parsed as StatePayload).iat !== 'number' ||
    typeof (parsed as StatePayload).nonce !== 'string' ||
    (parsed as StatePayload).nonce.length === 0
  ) {
    throw new OauthStateError('payload de state inválido');
  }
  const payload = parsed as StatePayload;
  if (payload.iat - now > MAX_FUTURE_SKEW_MS) {
    throw new OauthStateError('state emitido no futuro');
  }
  if (now - payload.iat > MAX_AGE_MS) {
    throw new OauthStateError('state expirado');
  }
  return { id: payload.id, nonce: payload.nonce };
}
