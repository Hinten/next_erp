import { describe, expect, it } from 'vitest';
import {
  formatTelefone,
  formatTelefoneLocal,
  isValidTelefone,
  localTelefone,
  localTelefoneOrNull,
  normalizeTelefone,
  telefoneQueryShapes,
} from './index';

describe('normalizeTelefone', () => {
  it('prepends 55 to a 10-digit BR landline (DDD + subscriber)', () => {
    expect(normalizeTelefone('1133334444')).toBe('551133334444');
  });

  it('prepends 55 to an 11-digit BR mobile (DDD + 9 + subscriber)', () => {
    expect(normalizeTelefone('11999998888')).toBe('5511999998888');
  });

  it('keeps an already-normalized number unchanged (idempotent)', () => {
    expect(normalizeTelefone('5511999998888')).toBe('5511999998888');
    expect(normalizeTelefone(normalizeTelefone('11999998888'))).toBe(
      normalizeTelefone('11999998888'),
    );
  });

  it('strips formatting before normalizing', () => {
    expect(normalizeTelefone('+55 (11) 99999-8888')).toBe('5511999998888');
    expect(normalizeTelefone('(11) 3333-4444')).toBe('551133334444');
  });

  it('treats any 10/11-digit input as BR, even a foreign subscriber number', () => {
    // BR assumption: a bare 10/11-digit number is always prefixed with 55,
    // so a foreign number of that length typed without its country code is
    // mis-tagged as Brazilian (callers must include the country code).
    expect(normalizeTelefone('14155552671')).toBe('5514155552671'); // 11 digits → BR
  });

  it('passes through numbers that already carry a country code (12+ digits)', () => {
    expect(normalizeTelefone('441632960961')).toBe('441632960961'); // 12 digits, not BR-shaped
    expect(normalizeTelefone('+1 415 555 26711')).toBe('141555526711'); // strips '+', already 12 digits
  });

  it('leaves too-short inputs as bare digits (schema rejects them)', () => {
    expect(normalizeTelefone('99998888')).toBe('99998888');
    expect(normalizeTelefone('')).toBe('');
  });
});

describe('isValidTelefone', () => {
  it('accepts 10 to 15 digits', () => {
    expect(isValidTelefone('1133334444')).toBe(true);
    expect(isValidTelefone('5511999998888')).toBe(true);
    expect(isValidTelefone('123456789012345')).toBe(true);
  });

  it('rejects out-of-bounds lengths', () => {
    expect(isValidTelefone('999988887')).toBe(false); // 9
    expect(isValidTelefone('1234567890123456')).toBe(false); // 16
  });

  it('rejects non-digit characters and empty input', () => {
    expect(isValidTelefone('+5511999998888')).toBe(false);
    expect(isValidTelefone('(11) 99999-8888')).toBe(false);
    expect(isValidTelefone('')).toBe(false);
  });
});

describe('telefoneQueryShapes', () => {
  it('returns both wire shapes for a raw BR number', () => {
    expect(telefoneQueryShapes('11999998888').sort()).toEqual(
      ['11999998888', '5511999998888'].sort(),
    );
  });

  it('returns both wire shapes for an already-normalized number', () => {
    expect(telefoneQueryShapes('5511999998888').sort()).toEqual(
      ['11999998888', '5511999998888'].sort(),
    );
  });

  it('strips formatting before deriving shapes', () => {
    expect(telefoneQueryShapes('+55 (11) 99999-8888').sort()).toEqual(
      ['11999998888', '5511999998888'].sort(),
    );
  });

  it('returns a single shape for non-BR numbers', () => {
    expect(telefoneQueryShapes('441632960961')).toEqual(['441632960961']);
  });

  it('returns an empty array for empty input', () => {
    expect(telefoneQueryShapes('')).toEqual([]);
    expect(telefoneQueryShapes('--')).toEqual([]);
  });
});

describe('localTelefone', () => {
  it('drops the BR country code from a normalized value', () => {
    expect(localTelefone('5511999998888')).toBe('11999998888');
    expect(localTelefone('551133334444')).toBe('1133334444');
  });

  it('leaves a legacy raw BR number alone — 10/11 digits are never normalized', () => {
    expect(localTelefone('11999998888')).toBe('11999998888');
    expect(localTelefone('1133334444')).toBe('1133334444');
  });

  it('leaves a foreign number alone — only 55 is stripped', () => {
    expect(localTelefone('441632960961')).toBe('441632960961');
  });

  it('inverts normalizeTelefone for the BR case', () => {
    expect(localTelefone(normalizeTelefone('11999998888'))).toBe('11999998888');
  });

  it('strips punctuation', () => {
    expect(localTelefone('+55 (11) 99999-8888')).toBe('11999998888');
  });
});

describe('localTelefoneOrNull', () => {
  it('strips the country code exactly like localTelefone for a real value', () => {
    expect(localTelefoneOrNull('5511999998888')).toBe('11999998888');
    expect(localTelefoneOrNull('11999998888')).toBe('11999998888');
    expect(localTelefoneOrNull('441632960961')).toBe('441632960961');
  });

  it('keeps an absent phone absent instead of turning it into an empty string', () => {
    // The whole point of the variant: `localTelefone('')` is `''`, which a
    // wire that omits empty fields would then have to special-case at every
    // call site.
    expect(localTelefoneOrNull('')).toBeNull();
    expect(localTelefoneOrNull(null)).toBeNull();
    expect(localTelefoneOrNull(undefined)).toBeNull();
  });
});

describe('formatTelefoneLocal', () => {
  it('masks a local mobile and landline', () => {
    expect(formatTelefoneLocal('11999998888')).toBe('(11) 99999-8888');
    expect(formatTelefoneLocal('1133334444')).toBe('(11) 3333-4444');
  });

  it('NEVER strips a country code — this is the shape a DANFE renders', () => {
    // The DANFE reads `fone` back out of a signed XML, in SEFAZ's shape. It
    // must show what was signed, so a 13-digit value passes through untouched
    // rather than being reinterpreted as `55` + a local number.
    expect(formatTelefoneLocal('5511999998888')).toBe('5511999998888');
  });

  it('returns any other length unchanged', () => {
    expect(formatTelefoneLocal('999')).toBe('999');
    expect(formatTelefoneLocal('')).toBe('');
  });
});

describe('formatTelefone', () => {
  it('masks a value stored in this repo’s wire format', () => {
    // The whole point: 13 digits used to fall through the mask and print raw.
    expect(formatTelefone('5511999998888')).toBe('(11) 99999-8888');
    expect(formatTelefone('551133334444')).toBe('(11) 3333-4444');
  });

  it('masks a legacy raw BR value the Flutter app wrote', () => {
    expect(formatTelefone('11999998888')).toBe('(11) 99999-8888');
    expect(formatTelefone('1133334444')).toBe('(11) 3333-4444');
  });

  it('returns the caller’s original string when it cannot mask', () => {
    // Not the stripped digits — nothing is silently mangled.
    expect(formatTelefone('441632960961')).toBe('441632960961');
    expect(formatTelefone('+44 1632 960961')).toBe('+44 1632 960961');
    expect(formatTelefone('999')).toBe('999');
  });

  it('is stable under repeated formatting of an already-masked value', () => {
    expect(formatTelefone(formatTelefone('5511999998888'))).toBe('(11) 99999-8888');
  });
});
