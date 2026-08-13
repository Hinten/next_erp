import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { MAX_AGE_MS, MAX_FUTURE_SKEW_MS, OauthStateError, signState, verifyState } from './state';

const SECRET = 'test-state-secret';

describe('signState / verifyState', () => {
  it('round-trips the id', () => {
    const { state } = signState('acc-123', SECRET, 1_000);
    expect(verifyState(state, SECRET, 1_500).id).toBe('acc-123');
  });

  it('returns the minted nonce and round-trips it', () => {
    // The nonce is what binds a state to its stored attempt (#821/T3, #1034).
    // Before the fix it was minted and dropped on the floor — unreachable by any
    // caller, so nothing could ever redeem it and every state was replayable.
    const { state, nonce } = signState('acc-123', SECRET, 1_000);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(verifyState(state, SECRET, 1_500).nonce).toBe(nonce);
  });

  it('mints a distinct nonce per call, same inputs', () => {
    const a = signState('acc-123', SECRET, 1_000);
    const b = signState('acc-123', SECRET, 1_000);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.state).not.toBe(b.state);
  });

  it('rejects a tampered payload', () => {
    const { state } = signState('acc-123', SECRET, 1_000);
    const [body, sig] = state.split('.');
    const forged = `${Buffer.from(JSON.stringify({ id: 'evil', iat: 1_000, nonce: 'x' })).toString(
      'base64url',
    )}.${sig}`;
    expect(() => verifyState(forged, SECRET)).toThrow(OauthStateError);
    // A different secret also fails.
    expect(() => verifyState(`${body}.${sig}`, 'other-secret')).toThrow(OauthStateError);
  });

  it('rejects an expired state', () => {
    const { state } = signState('acc-123', SECRET, 0);
    expect(() => verifyState(state, SECRET, MAX_AGE_MS + 1)).toThrow(OauthStateError);
    // Right at the boundary it is still good.
    expect(verifyState(signState('acc-123', SECRET, 0).state, SECRET, MAX_AGE_MS).id).toBe(
      'acc-123',
    );
  });

  it('rejects a state minted beyond the clock-skew tolerance', () => {
    // Without an upper bound a forward-dated `iat` never ages out: `now - iat`
    // stays negative and can never exceed MAX_AGE_MS. Melhor Envio and Mercado
    // Livre both lacked this for months while Mercado Pago had it — the drift
    // that motivated extracting this module.
    const { state } = signState('acc-123', SECRET, MAX_FUTURE_SKEW_MS + 1_000);
    expect(() => verifyState(state, SECRET, 0)).toThrow(OauthStateError);
    // Inside the tolerance it still verifies.
    const near = signState('acc-123', SECRET, MAX_FUTURE_SKEW_MS - 1_000);
    expect(verifyState(near.state, SECRET, 0).id).toBe('acc-123');
  });

  it('rejects a payload with no nonce', () => {
    const body = Buffer.from(JSON.stringify({ id: 'acc-123', iat: 1_000 })).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
    expect(() => verifyState(`${body}.${sig}`, SECRET, 1_500)).toThrow(OauthStateError);
  });

  it('rejects a payload with an empty id', () => {
    const body = Buffer.from(JSON.stringify({ id: '', iat: 1_000, nonce: 'n' })).toString(
      'base64url',
    );
    const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
    expect(() => verifyState(`${body}.${sig}`, SECRET, 1_500)).toThrow(OauthStateError);
  });

  it('rejects a malformed state', () => {
    expect(() => verifyState('not-a-state', SECRET)).toThrow(OauthStateError);
    expect(() => verifyState('', SECRET)).toThrow(OauthStateError);
    expect(() => verifyState('.sig-only', SECRET)).toThrow(OauthStateError);
  });

  it('rejects a body that is valid base64url but not JSON', () => {
    const body = Buffer.from('not json at all').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
    expect(() => verifyState(`${body}.${sig}`, SECRET)).toThrow(OauthStateError);
  });
});
