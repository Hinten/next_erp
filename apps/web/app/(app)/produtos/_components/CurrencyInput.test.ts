import { describe, expect, it } from 'vitest';
import { parseBrl } from './CurrencyInput';

describe('parseBrl', () => {
  it('passes finite numbers through', () => {
    expect(parseBrl(30)).toBe(30);
    expect(parseBrl(0)).toBe(0);
    expect(parseBrl(30.5)).toBe(30.5);
  });

  it('parses plain numeric strings (Playwright .fill / Mantine onChange)', () => {
    expect(parseBrl('30')).toBe(30);
    expect(parseBrl('0')).toBe(0);
  });

  it('accepts the comma as the decimal separator (pt-BR)', () => {
    expect(parseBrl('30,5')).toBe(30.5);
    expect(parseBrl('30,55')).toBe(30.55);
  });

  it('accepts a lone dot as the decimal separator too', () => {
    expect(parseBrl('30.5')).toBe(30.5);
  });

  it('folds thousands dots that precede a comma (no ×100/×1000 mis-scale)', () => {
    expect(parseBrl('1.234,56')).toBe(1234.56);
    expect(parseBrl('R$ 1.234,56')).toBe(1234.56);
  });

  it('strips the R$ prefix and surrounding whitespace', () => {
    expect(parseBrl('R$ 30,00')).toBe(30);
    expect(parseBrl(' R$ 42 ')).toBe(42);
  });

  it('returns null for an empty/cleared input', () => {
    expect(parseBrl('')).toBeNull();
    expect(parseBrl('R$ ')).toBeNull();
    expect(parseBrl('-')).toBeNull();
  });

  it('returns null for NaN / non-string non-number', () => {
    expect(parseBrl(Number.NaN)).toBeNull();
    expect(parseBrl(undefined as unknown as string)).toBeNull();
  });
});
