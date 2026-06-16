import { describe, expect, it } from 'vitest';
import { isValidTelefone, normalizeTelefone, telefoneQueryShapes } from './index';

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
