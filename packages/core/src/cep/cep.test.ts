import { describe, expect, it } from 'vitest';
import { cleanCep, formatCep, isCepCompleto } from './cep';

describe('cleanCep', () => {
  it('strips punctuation and caps at 8 digits', () => {
    expect(cleanCep('01310-100')).toBe('01310100');
    expect(cleanCep(' 01310 100 ')).toBe('01310100');
    expect(cleanCep('013101009999')).toBe('01310100');
  });

  it('preserves leading zeros', () => {
    // Load-bearing: the CEP→cMun table (#785) parses this to a number, and the
    // stored schema form is `/^\d{8}$/` — dropping a leading zero here would
    // shift every São Paulo capital CEP into a different faixa.
    expect(cleanCep('01001000')).toBe('01001000');
  });

  it('returns an empty string for nullish or letters-only input', () => {
    expect(cleanCep(null)).toBe('');
    expect(cleanCep(undefined)).toBe('');
    expect(cleanCep('abc')).toBe('');
  });
});

describe('isCepCompleto', () => {
  it('accepts a full CEP in either form', () => {
    expect(isCepCompleto('01310100')).toBe(true);
    expect(isCepCompleto('01310-100')).toBe(true);
  });

  it('rejects a partial or missing CEP', () => {
    expect(isCepCompleto('0131010')).toBe(false);
    expect(isCepCompleto('')).toBe(false);
    expect(isCepCompleto(null)).toBe(false);
  });
});

describe('formatCep', () => {
  it('applies the #####-### mask', () => {
    expect(formatCep('01310100')).toBe('01310-100');
  });

  it('passes partial input through so it is keystroke-safe', () => {
    expect(formatCep('013')).toBe('013');
    expect(formatCep('01310')).toBe('01310');
    expect(formatCep('013101')).toBe('01310-1');
    expect(formatCep('')).toBe('');
  });
});
