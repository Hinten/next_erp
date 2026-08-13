import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { MarketplaceStateError, signState, verifyState } from './state';

const SECRET = 'test-state-secret';

describe('signState / verifyState', () => {
  it('round-trips the integracaoId', () => {
    const { state } = signState('int-123', SECRET, 1_000);
    expect(verifyState(state, SECRET, 1_500).integracaoId).toBe('int-123');
  });

  it('returns the minted nonce and round-trips it', () => {
    // The nonce is what binds a state to its stored attempt (#821/T3). It used
    // to be minted and dropped on the floor — unreachable by any caller, so
    // nothing could ever consume it and every state was replayable.
    const { state, nonce } = signState('int-123', SECRET, 1_000);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(verifyState(state, SECRET, 1_500).nonce).toBe(nonce);
  });

  it('mints a distinct nonce per call, same inputs', () => {
    const a = signState('int-123', SECRET, 1_000);
    const b = signState('int-123', SECRET, 1_000);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.state).not.toBe(b.state);
  });

  it('rejects a tampered payload', () => {
    const { state } = signState('int-123', SECRET, 1_000);
    const [body, sig] = state.split('.');
    const forged = `${Buffer.from(JSON.stringify({ integracaoId: 'evil', iat: 1_000, nonce: 'x' })).toString('base64url')}.${sig}`;
    expect(() => verifyState(forged, SECRET)).toThrow(MarketplaceStateError);
    // A different secret also fails.
    expect(() => verifyState(`${body}.${sig}`, 'other-secret')).toThrow(MarketplaceStateError);
  });

  it('rejects an expired state (> 10 min)', () => {
    const { state } = signState('int-123', SECRET, 0);
    expect(() => verifyState(state, SECRET, 11 * 60 * 1000)).toThrow(MarketplaceStateError);
  });

  it('rejects a state minted beyond the clock-skew tolerance', () => {
    // Without an upper bound a forward-dated `iat` never ages out, so the
    // freshness window would be unbounded in one direction.
    const { state } = signState('int-123', SECRET, 5 * 60 * 1000);
    expect(() => verifyState(state, SECRET, 0)).toThrow(MarketplaceStateError);
    // Inside the tolerance it still verifies.
    const near = signState('int-123', SECRET, 30_000);
    expect(verifyState(near.state, SECRET, 0).integracaoId).toBe('int-123');
  });

  it('rejects a payload with no nonce', () => {
    const body = Buffer.from(JSON.stringify({ integracaoId: 'int-123', iat: 1_000 })).toString(
      'base64url',
    );
    const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
    expect(() => verifyState(`${body}.${sig}`, SECRET, 1_500)).toThrow(MarketplaceStateError);
  });

  it('rejects a malformed state', () => {
    expect(() => verifyState('not-a-state', SECRET)).toThrow(MarketplaceStateError);
  });
});
