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

  it('defensively handles a raw legacy scalar string (a parseSoftRead fallback)', () => {
    // Belt-and-suspenders alongside regraImpostoSchema's own read-tolerant
    // preprocess: a doc that fails parseSoftRead for an UNRELATED reason
    // still comes back with NVE possibly a bare string, and this must not
    // throw (`.join` is not a string method).
    expect(formatNveText('AB1234')).toBe('AB1234');
    expect(formatNveText('   ')).toBeNull();
    expect(formatNveText('')).toBeNull();
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
  // 'S'/'N' is the domain convention elsewhere in this repo (the NF-e XSD
  // enum, and the produto/categoria imposto tabs an operator edits through
  // this same free-text widget) — an operator's muscle memory here is S/N,
  // not sim/não.
  it('formats true/false/null to S/N/null, round-trippable', () => {
    expect(formatIndEscalaText(true)).toBe('S');
    expect(formatIndEscalaText(false)).toBe('N');
    expect(formatIndEscalaText(null)).toBeNull();
  });

  it('parses the affirmative words as true, case-insensitively', () => {
    expect(parseIndEscalaText('S')).toBe(true);
    expect(parseIndEscalaText('s')).toBe(true);
    expect(parseIndEscalaText('sim')).toBe(true);
    expect(parseIndEscalaText('Sim')).toBe(true);
    expect(parseIndEscalaText('true')).toBe(true);
    expect(parseIndEscalaText('1')).toBe(true);
  });

  it('parses the negative words as false, case-insensitively — including bare N', () => {
    expect(parseIndEscalaText('N')).toBe(false);
    expect(parseIndEscalaText('n')).toBe(false);
    expect(parseIndEscalaText('não')).toBe(false);
    expect(parseIndEscalaText('Não')).toBe(false);
    expect(parseIndEscalaText('nao')).toBe(false);
    expect(parseIndEscalaText('false')).toBe(false);
    expect(parseIndEscalaText('0')).toBe(false);
  });

  it('parses unrecognized non-blank text as null (never guesses)', () => {
    // A silently flipped "N" would be worse than asking the operator to
    // retype it — so anything outside the known S/N vocabulary is treated
    // as not-set, never coerced to true.
    expect(parseIndEscalaText('qualquer coisa')).toBeNull();
    expect(parseIndEscalaText('talvez')).toBeNull();
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
