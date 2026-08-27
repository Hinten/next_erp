import { describe, expect, it } from 'vitest';

import { envelopeDeErro } from './index';

/**
 * Every client used to read a non-2xx body with a bare
 * `parsed as { error?: string; code?: string }`. `3a4b7278` replaced that in the
 * Mercado Livre client and the three siblings never got the same treatment.
 */
describe('envelopeDeErro', () => {
  it('reads our envelope', () => {
    expect(envelopeDeErro({ error: 'x', code: 'C', issues: ['a'] })).toEqual({
      error: 'x',
      code: 'C',
      issues: ['a'],
    });
  });

  it('⭐ answers null for a body that is not an object at all', () => {
    // ⚠️ An ARRAY is the case worth naming: `typeof [] === 'object'`, so a
    // null-check alone lets it through and the caller reads an "envelope" with
    // no fields — indistinguishable from a real one that happened to be empty.
    expect(envelopeDeErro([1, 2, 3])).toBeNull();
    expect(envelopeDeErro(null)).toBeNull();
    expect(envelopeDeErro('uma string')).toBeNull();
    expect(envelopeDeErro(42)).toBeNull();
  });

  it('drops a field of the wrong type instead of passing it through', () => {
    // The old cast let a number ride into `err.message`, where it became the
    // string "500" with no context.
    expect(envelopeDeErro({ error: 500, code: [], issues: 'nao-e-array' })).toEqual({});
  });

  it('stringifies issue entries rather than trusting them', () => {
    expect(envelopeDeErro({ issues: ['a', 2] })).toEqual({ issues: ['a', '2'] });
  });

  it('an object with none of the three fields is an EMPTY envelope, not null', () => {
    // The control for the array case: object-ness is what decides, and an object
    // genuinely was one — it just carried nothing we recognise.
    expect(envelopeDeErro({ outraCoisa: 1 })).toEqual({});
  });
});
