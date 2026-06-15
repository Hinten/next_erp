import { describe, expect, it } from 'vitest';

import { FreightStateError, signState, verifyState } from './state';

const SECRET = 'test-state-secret';

describe('signState / verifyState', () => {
  it('round-trips the intFreteId', () => {
    const state = signState('int-1', SECRET, 1_000);
    expect(verifyState(state, SECRET, 1_000).intFreteId).toBe('int-1');
  });

  it('rejects a tampered payload (signature mismatch)', () => {
    const state = signState('int-1', SECRET, 1_000);
    const sig = state.slice(state.indexOf('.') + 1);
    const evilBody = Buffer.from(
      JSON.stringify({ intFreteId: 'int-EVIL', iat: 1_000, nonce: 'x' }),
    ).toString('base64url');
    expect(() => verifyState(`${evilBody}.${sig}`, SECRET, 1_000)).toThrow(FreightStateError);
  });

  it('rejects a wrong secret', () => {
    const state = signState('int-1', SECRET, 1_000);
    expect(() => verifyState(state, 'other-secret', 1_000)).toThrow(FreightStateError);
  });

  it('rejects an expired state (older than 10 min)', () => {
    const state = signState('int-1', SECRET, 1_000);
    expect(() => verifyState(state, SECRET, 1_000 + 11 * 60 * 1_000)).toThrow(/expirado/);
  });

  it('rejects a malformed state', () => {
    expect(() => verifyState('garbage-no-dot', SECRET)).toThrow(FreightStateError);
  });
});
