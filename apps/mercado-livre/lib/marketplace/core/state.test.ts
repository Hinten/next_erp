import { describe, it, expect } from 'vitest';
import { MarketplaceStateError, signState, verifyState } from './state';

const SECRET = 'test-state-secret';

describe('signState / verifyState', () => {
  it('round-trips the integracaoId', () => {
    const state = signState('int-123', SECRET, 1_000);
    expect(verifyState(state, SECRET, 1_500).integracaoId).toBe('int-123');
  });

  it('rejects a tampered payload', () => {
    const state = signState('int-123', SECRET, 1_000);
    const [body, sig] = state.split('.');
    const forged = `${Buffer.from(JSON.stringify({ integracaoId: 'evil', iat: 1_000, nonce: 'x' })).toString('base64url')}.${sig}`;
    expect(() => verifyState(forged, SECRET)).toThrow(MarketplaceStateError);
    // A different secret also fails.
    expect(() => verifyState(`${body}.${sig}`, 'other-secret')).toThrow(MarketplaceStateError);
  });

  it('rejects an expired state (> 10 min)', () => {
    const state = signState('int-123', SECRET, 0);
    expect(() => verifyState(state, SECRET, 11 * 60 * 1000)).toThrow(MarketplaceStateError);
  });

  it('rejects a malformed state', () => {
    expect(() => verifyState('not-a-state', SECRET)).toThrow(MarketplaceStateError);
  });
});
