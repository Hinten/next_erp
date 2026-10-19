import { createHash, timingSafeEqual } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyStaticSecret } from './index';

// A PASSTHROUGH spy: `timingSafeEqual` still runs for real, and every call is
// recorded. The booleans alone cannot pin what this primitive exists for (§3
// decision 14): a plain `===`, or a raw-buffer compare behind an early
// `a.length !== b.length` return, answers the same true/false on every input.
vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, timingSafeEqual: vi.fn(original.timingSafeEqual) };
});

const comparacoes = vi.mocked(timingSafeEqual);

const SEGREDO = 'f'.repeat(64);

const sha256 = (valor: string) => createHash('sha256').update(valor, 'utf8').digest();

beforeEach(() => {
  comparacoes.mockClear();
});

describe('verifyStaticSecret', () => {
  it('accepts the exact secret', () => {
    expect(verifyStaticSecret({ received: SEGREDO, expected: SEGREDO })).toBe(true);
  });

  it('rejects a value of the same length one byte off', () => {
    const umByteDiferente = `${SEGREDO.slice(0, -1)}e`;
    expect(umByteDiferente).toHaveLength(SEGREDO.length);
    expect(verifyStaticSecret({ received: umByteDiferente, expected: SEGREDO })).toBe(false);
  });

  it.each([
    ['shorter', SEGREDO.slice(0, -1)],
    ['longer', `${SEGREDO}f`],
    ['with a trailing newline', `${SEGREDO}\n`],
    ['with a trailing space', `${SEGREDO} `],
    ['upper-cased', SEGREDO.toUpperCase()],
  ])('rejects a %s value without throwing', (_caso, received) => {
    const verificar = () => verifyStaticSecret({ received, expected: SEGREDO });
    expect(verificar).not.toThrow();
    expect(verificar()).toBe(false);
  });

  it('compares unicode as UTF-8 bytes: equal text matches, another normalisation does not', () => {
    const nfc = 'segredo-ação-'.normalize('NFC') + 'x'.repeat(32);
    const nfd = 'segredo-ação-'.normalize('NFD') + 'x'.repeat(32);
    expect(nfc).not.toBe(nfd);
    expect(verifyStaticSecret({ received: nfc, expected: nfc })).toBe(true);
    expect(verifyStaticSecret({ received: nfd, expected: nfc })).toBe(false);
  });

  it.each([null, undefined, ''])(
    'a missing or empty received value (%j) never matches',
    (received) => {
      expect(verifyStaticSecret({ received, expected: SEGREDO })).toBe(false);
    },
  );

  it.each(['', ' ', '\n', '\t \r\n'])(
    'a blank expected secret (%j) throws instead of comparing',
    (expected) => {
      expect(() => verifyStaticSecret({ received: expected, expected })).toThrow(TypeError);
      expect(() => verifyStaticSecret({ received: SEGREDO, expected })).toThrow(TypeError);
    },
  );

  it('does not trim the expected secret either: a padded one is a different secret', () => {
    expect(verifyStaticSecret({ received: SEGREDO, expected: ` ${SEGREDO}` })).toBe(false);
    expect(verifyStaticSecret({ received: ` ${SEGREDO}`, expected: ` ${SEGREDO}` })).toBe(true);
  });
});

describe('verifyStaticSecret: the comparison itself (§3 decision 14)', () => {
  const nfc = 'segredo-ação-'.normalize('NFC') + 'x'.repeat(32);

  it.each([
    ['the exact secret', SEGREDO, SEGREDO, true],
    ['one byte off, same length', `${SEGREDO.slice(0, -1)}e`, SEGREDO, false],
    ['one character shorter', SEGREDO.slice(0, -1), SEGREDO, false],
    ['one character longer', `${SEGREDO}f`, SEGREDO, false],
    ['a single character', 'f', SEGREDO, false],
    ['ten times longer', SEGREDO.repeat(10), SEGREDO, false],
    ['with a trailing newline', `${SEGREDO}\n`, SEGREDO, false],
    ['with a trailing space', `${SEGREDO} `, SEGREDO, false],
    ['unicode, equal', nfc, nfc, true],
    ['unicode, another normalisation', nfc.normalize('NFD'), nfc, false],
  ])(
    '%s: exactly ONE timingSafeEqual, over the two 32-byte SHA-256 digests',
    (_caso, received, expected, casa) => {
      expect(verifyStaticSecret({ received, expected })).toBe(casa);
      expect(comparacoes).toHaveBeenCalledTimes(1);
      const [a, b] = comparacoes.mock.calls[0] ?? [];
      // Whatever the input lengths, the compare runs over 32 bytes each: no
      // length leaks, and nothing for the caller to pad.
      expect([Buffer.isBuffer(a), Buffer.isBuffer(b)]).toEqual([true, true]);
      expect([(a as Buffer).length, (b as Buffer).length]).toEqual([32, 32]);
      expect((a as Buffer).equals(sha256(received))).toBe(true);
      expect((b as Buffer).equals(sha256(expected))).toBe(true);
    },
  );

  it.each([null, undefined, ''])(
    'a missing or empty received value (%j) returns before comparing: zero calls',
    (received) => {
      expect(verifyStaticSecret({ received, expected: SEGREDO })).toBe(false);
      expect(comparacoes).not.toHaveBeenCalled();
    },
  );

  it('a blank expected secret throws before comparing: zero calls', () => {
    expect(() => verifyStaticSecret({ received: SEGREDO, expected: ' ' })).toThrow(TypeError);
    expect(comparacoes).not.toHaveBeenCalled();
  });
});
