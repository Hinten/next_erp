import { describe, it, expect } from 'vitest';
import { PaymentStateError, signState, verifyState } from './state';

const SECRET = 'test-state-secret';

describe('signState / verifyState', () => {
  it('round-trips the metodoId', () => {
    const state = signState('metodo-123', SECRET, 1_000);
    expect(verifyState(state, SECRET, 1_500).metodoId).toBe('metodo-123');
  });

  it('rejects a tampered payload', () => {
    const state = signState('metodo-123', SECRET, 1_000);
    const [body, sig] = state.split('.');
    const forged = `${Buffer.from(JSON.stringify({ metodoId: 'evil', iat: 1_000, nonce: 'x' })).toString('base64url')}.${sig}`;
    expect(() => verifyState(forged, SECRET)).toThrow(PaymentStateError);
    // A different secret also fails.
    expect(() => verifyState(`${body}.${sig}`, 'other-secret')).toThrow(PaymentStateError);
  });

  it('rejects an expired state (> 10 min)', () => {
    const state = signState('metodo-123', SECRET, 0);
    expect(() => verifyState(state, SECRET, 11 * 60 * 1000)).toThrow(PaymentStateError);
  });

  it('rejects a malformed state', () => {
    expect(() => verifyState('not-a-state', SECRET)).toThrow(PaymentStateError);
  });

  it('rejects a state minted in the future (> 60s skew)', () => {
    const state = signState('metodo-123', SECRET, 10 * 60 * 1000);
    expect(() => verifyState(state, SECRET, 0)).toThrow(PaymentStateError);
    // Small forward skew (≤ 60s) stays accepted.
    const slightlyAhead = signState('metodo-123', SECRET, 30_000);
    expect(verifyState(slightlyAhead, SECRET, 0).metodoId).toBe('metodo-123');
  });
});
