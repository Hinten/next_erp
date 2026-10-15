import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvCell, csvRow } from './index';

describe('shared CSV formatting', () => {
  it.each([
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1+1', "'+1+1"],
    ['-DESCONTO', "'-DESCONTO"],
    ['@cmd', "'@cmd"],
    ['\t=cmd', "'\t=cmd"],
    ['\r=cmd', '"\'\r=cmd"'],
    ['\n=cmd', '"\'\n=cmd"'],
    ['  =cmd', "'  =cmd"],
    ['\u0000=cmd', "'\u0000=cmd"],
    ['=A1;B1', '"\'=A1;B1"'],
    ['-10', "'-10"],
  ])('neutralizes the text cell %j before quoting', (raw, expected) => {
    expect(csvCell(raw)).toBe(expected);
  });

  it('preserves ordinary cells and escapes delimiters, quotes and multiline text', () => {
    expect(csvCell('Ana')).toBe('Ana');
    expect(csvCell('001')).toBe('001');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(42)).toBe('42');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('Ana; "B"\nSilva')).toBe('"Ana; ""B""\nSilva"');
  });

  it('preserves numbers and explicitly numeric decimal strings, but not formulas', () => {
    expect(csvCell(-10)).toBe('-10');
    expect(csvCell('-10', { numericStrings: true })).toBe('-10');
    expect(csvCell('-5,50', { numericStrings: true })).toBe('-5,50');
    expect(csvCell('103,00', { numericStrings: true })).toBe('103,00');
    expect(csvCell('1234.56', { numericStrings: true })).toBe('1234.56');
    expect(csvCell('-5,50')).toBe("'-5,50");
    expect(csvCell('-5+50', { numericStrings: true })).toBe("'-5+50");
    expect(csvCell('  =cmd', { numericStrings: true })).toBe("'  =cmd");
    expect(csvCell('\n=cmd', { numericStrings: true })).toBe('"\'\n=cmd"');
  });

  it('uses a UTF-8 BOM and joins escaped cells with semicolons', () => {
    expect(CSV_BOM).toBe(String.fromCharCode(0xfeff));
    expect(csvRow(['a;b', 'c', null, 42])).toBe('"a;b";c;;42');
    expect(csvRow(['Total', '-5,50'], { numericStrings: true })).toBe('Total;-5,50');
    expect(csvRow(['-10', 3])).toBe("'-10;3");
  });
});
