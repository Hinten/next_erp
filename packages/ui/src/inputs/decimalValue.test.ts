import { describe, expect, it } from 'vitest';

import { parseDecimalInput } from './decimalValue';

describe('parseDecimalInput', () => {
  it('passes a finite number straight through', () => {
    expect(parseDecimalInput(1.5)).toBe(1.5);
    expect(parseDecimalInput(0)).toBe(0);
    expect(parseDecimalInput(-3)).toBe(-3);
  });

  it('rejects a non-finite number', () => {
    expect(parseDecimalInput(Number.NaN)).toBeNull();
    expect(parseDecimalInput(Number.POSITIVE_INFINITY)).toBeNull();
  });

  /**
   * The four shapes Mantine emits as a STRING mid-typing. Each one is a
   * keystroke an operator actually presses, and each one used to wipe the
   * field. These are the load-bearing cases.
   */
  describe("Mantine's in-progress strings", () => {
    it('keeps the value on a trailing separator (trailingDecimalSeparatorPattern)', () => {
      expect(parseDecimalInput('1.')).toBe(1);
      expect(parseDecimalInput('25.')).toBe(25);
      expect(parseDecimalInput('-4.')).toBe(-4);
    });

    it('keeps the value on a trailing zero (trailingZerosPattern)', () => {
      expect(parseDecimalInput('1.0')).toBe(1);
      expect(parseDecimalInput('1.50')).toBe(1.5);
      expect(parseDecimalInput('2.10')).toBe(2.1);
    });

    it('keeps the value on a leading decimal zero (leadingDecimalZeroPattern)', () => {
      expect(parseDecimalInput('0.')).toBe(0);
      expect(parseDecimalInput('0.0')).toBe(0);
      expect(parseDecimalInput('0.00')).toBe(0);
    });

    it('reports an empty or sign-only field as null, never 0', () => {
      // `Number('')` is 0 — the reason a cleared nullable field used to be
      // saved as zero instead of being cleared.
      expect(parseDecimalInput('')).toBeNull();
      expect(parseDecimalInput('-')).toBeNull();
      expect(parseDecimalInput('.')).toBeNull();
    });
  });

  /**
   * Not produced by Mantine (its string is react-number-format's unformatted,
   * dot-decimal `value`) but produced by a Playwright `.fill()` and by a human
   * pasting a pt-BR number.
   */
  describe('pt-BR text', () => {
    it('reads a decimal comma', () => {
      expect(parseDecimalInput('1,5')).toBe(1.5);
      expect(parseDecimalInput('30,50')).toBe(30.5);
    });

    it('folds thousands dots only when a comma follows', () => {
      expect(parseDecimalInput('1.234,56')).toBe(1234.56);
      expect(parseDecimalInput('1.234.567,89')).toBe(1234567.89);
      // No comma -> the dot IS the decimal separator, not a thousands mark.
      expect(parseDecimalInput('1.234')).toBe(1.234);
    });

    it('drops a currency prefix and whitespace', () => {
      expect(parseDecimalInput('R$ 30,00')).toBe(30);
      expect(parseDecimalInput('R$\u00a01.234,56')).toBe(1234.56);
    });
  });

  it('normalises -0 to 0', () => {
    expect(Object.is(parseDecimalInput('-0'), 0)).toBe(true);
    expect(Object.is(parseDecimalInput('-0.0'), 0)).toBe(true);
  });

  it('rejects text that is not a number at all', () => {
    expect(parseDecimalInput('abc')).toBeNull();
    expect(parseDecimalInput('1.2.3')).toBeNull();
  });

  it('rejects a value that is neither string nor number', () => {
    expect(parseDecimalInput(undefined as unknown as string)).toBeNull();
    expect(parseDecimalInput(null as unknown as string)).toBeNull();
  });
});
