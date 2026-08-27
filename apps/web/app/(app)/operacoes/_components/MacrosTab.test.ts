import { describe, expect, it } from 'vitest';
import { formatIndEscalaText, formatNveText, parseIndEscalaText, parseNveText } from './MacrosTab';

// regraImpostoSchema types NVE as string[] and indEscala as boolean (#468 —
// the legacy wire shape), but the shared DadosGeraisSection editor (reused
// as-is by produto/categoria/operação, which still store both as plain
// strings) only edits a free-text value. These pure helpers are the bridge —
// pinned here since a save-path regression here throws a ZodError the
// operator sees as "Dados inválidos", not a crash the test suite would catch
// any other way.

describe('NVE text bridge', () => {
  it('formats an array as a comma-joined string', () => {
    expect(formatNveText(['12345678', '87654321'])).toBe('12345678, 87654321');
  });

  it('formats an empty/null array as null', () => {
    expect(formatNveText(null)).toBeNull();
    expect(formatNveText([])).toBeNull();
  });

  it('parses a comma-separated string back into a trimmed array', () => {
    expect(parseNveText('12345678, 87654321')).toEqual(['12345678', '87654321']);
  });

  it('parses blank/whitespace-only text as null', () => {
    expect(parseNveText('')).toBeNull();
    expect(parseNveText('   ')).toBeNull();
    expect(parseNveText(null)).toBeNull();
    expect(parseNveText(undefined)).toBeNull();
  });

  it('round-trips losslessly through an unedited save', () => {
    const stored: string[] | null = ['AB12', 'CD34'];
    expect(parseNveText(formatNveText(stored))).toEqual(stored);
    expect(parseNveText(formatNveText(null))).toBeNull();
  });
});

describe('indEscala text bridge', () => {
  it('formats true/false/null to distinct, round-trippable text', () => {
    expect(formatIndEscalaText(true)).toBe('sim');
    expect(formatIndEscalaText(false)).toBe('não');
    expect(formatIndEscalaText(null)).toBeNull();
  });

  it('parses "sim" (or any non-negative text) as true', () => {
    expect(parseIndEscalaText('sim')).toBe(true);
    expect(parseIndEscalaText('qualquer coisa')).toBe(true);
  });

  it('parses the negative words as false, case-insensitively', () => {
    expect(parseIndEscalaText('não')).toBe(false);
    expect(parseIndEscalaText('Não')).toBe(false);
    expect(parseIndEscalaText('nao')).toBe(false);
    expect(parseIndEscalaText('false')).toBe(false);
    expect(parseIndEscalaText('0')).toBe(false);
  });

  it('parses blank text as null (not false)', () => {
    expect(parseIndEscalaText('')).toBeNull();
    expect(parseIndEscalaText('   ')).toBeNull();
    expect(parseIndEscalaText(null)).toBeNull();
    expect(parseIndEscalaText(undefined)).toBeNull();
  });

  it('round-trips all three states losslessly through an unedited save', () => {
    for (const v of [true, false, null]) {
      expect(parseIndEscalaText(formatIndEscalaText(v))).toBe(v);
    }
  });
});
