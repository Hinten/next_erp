import { describe, expect, it } from 'vitest';

import { montarRef, versaoDaRef } from './refCredencial';

const FINGERPRINT = '356650d83857e2ca';
const MS = 1_790_000_000_000;

describe('montarRef / versaoDaRef', () => {
  it('round trip: the version of a built ref is the stamp, as digits', () => {
    expect(montarRef(FINGERPRINT, MS)).toBe(`${FINGERPRINT}.${String(MS)}`);
    expect(versaoDaRef(montarRef(FINGERPRINT, MS))).toBe(String(MS));
    expect(versaoDaRef(montarRef(FINGERPRINT, 0))).toBe('0');
  });

  it('the version never carries the fingerprint', () => {
    expect(versaoDaRef(montarRef(FINGERPRINT, MS))).not.toContain(FINGERPRINT);
  });

  it.each([
    ['the validator label', 'candidato'],
    ['16 hex with no dot', FINGERPRINT],
    ['16 hex and a dot, no digits', `${FINGERPRINT}.`],
    ['uppercase hex', `${FINGERPRINT.toUpperCase()}.${String(MS)}`],
    ['15 hex', `${FINGERPRINT.slice(1)}.${String(MS)}`],
    ['17 hex', `${FINGERPRINT}0.${String(MS)}`],
    ['a negative stamp', montarRef(FINGERPRINT, -5)],
    ['a fractional stamp', montarRef(FINGERPRINT, 1.5)],
    ['17 digits', `${FINGERPRINT}.${'1'.repeat(17)}`],
    ['a trailing space', `${FINGERPRINT}.${String(MS)} `],
    ['a leading space', ` ${FINGERPRINT}.${String(MS)}`],
    ['empty', ''],
  ])('near-miss: %s → null', (_caso, ref) => {
    expect(versaoDaRef(ref)).toBeNull();
  });
});
