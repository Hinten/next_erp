import { describe, expect, it } from 'vitest';
import {
  type CMunRange,
  CMunTableError,
  decodeCMunTable,
  decodeU32List,
  encodeCMunTable,
  encodeU32List,
} from './codec';

describe('encodeU32List / decodeU32List', () => {
  it('round-trips a list of u32 values', () => {
    const values = [0, 1, 35, 36, 999, 1_310_100, 99_999_999, 0xffffffff];
    const encoded = encodeU32List(values);

    expect([...decodeU32List(encoded, values.length)]).toEqual(values);
  });

  it('encodes in base36', () => {
    expect(encodeU32List([0, 35, 36, 1_310_100])).toBe('0,z,10,s2vo');
  });

  it('round-trips the empty list', () => {
    expect(encodeU32List([])).toBe('');
    expect([...decodeU32List('', 0)]).toEqual([]);
  });

  it('rejects a negative, fractional or oversized value', () => {
    expect(() => encodeU32List([-1])).toThrow(CMunTableError);
    expect(() => encodeU32List([1.5])).toThrow(CMunTableError);
    expect(() => encodeU32List([0x1_0000_0000])).toThrow(CMunTableError);
  });

  it('rejects a length mismatch in either direction', () => {
    expect(() => decodeU32List('1,2,3', 2)).toThrow(CMunTableError);
    expect(() => decodeU32List('1,2,3', 4)).toThrow(CMunTableError);
    expect(() => decodeU32List('', 3)).toThrow(CMunTableError);
  });

  it('rejects a character outside base36', () => {
    // Uppercase is NOT valid — `Number#toString(36)` emits lowercase, so an
    // uppercase digit means the data was mangled somewhere. X/Y/Z are the
    // dangerous ones: naive `code - 87` arithmetic maps them onto 1/2/3, so
    // they would decode as plausible data instead of failing.
    expect(() => decodeU32List('1,X,3', 3)).toThrow(CMunTableError);
    expect(() => decodeU32List('1,Y,3', 3)).toThrow(CMunTableError);
    expect(() => decodeU32List('1,Z,3', 3)).toThrow(CMunTableError);
    expect(() => decodeU32List('1,A,3', 3)).toThrow(CMunTableError);
    expect(() => decodeU32List('1, 2,3', 3)).toThrow(CMunTableError);
    expect(() => decodeU32List('1,2-3', 2)).toThrow(CMunTableError);
    expect(() => decodeU32List('1,ç,3', 3)).toThrow(CMunTableError);
  });
});

describe('encodeCMunTable / decodeCMunTable', () => {
  const RANGES: readonly CMunRange[] = [
    { cepInicial: 1_000_000, cepFinal: 1_099_999, cMun: 3_550_308 },
    { cepInicial: 1_100_000, cepFinal: 1_199_999, cMun: 3_550_308 }, // adjacent, same município
    { cepInicial: 2_000_000, cepFinal: 2_000_000, cMun: 3_304_557 }, // gap before, single CEP
  ];

  it('round-trips ranges through the encoded columns', () => {
    const table = decodeCMunTable(encodeCMunTable(RANGES));

    expect([...table.starts]).toEqual([1_000_000, 1_100_000, 2_000_000]);
    expect([...table.ends]).toEqual([1_099_999, 1_199_999, 2_000_000]);
    expect([...table.codes]).toEqual([3_550_308, 3_550_308, 3_304_557]);
  });

  it('round-trips the empty table (the unvendored placeholder)', () => {
    const table = decodeCMunTable(encodeCMunTable([]));

    expect(table.starts).toHaveLength(0);
    expect(table.ends).toHaveLength(0);
  });

  it('refuses to encode overlapping ranges', () => {
    // The gap encoding makes an overlap structurally unrepresentable: a
    // negative gap cannot be stored, so the generator MUST reject the dump
    // rather than emit a table whose binary search would be undefined.
    expect(() =>
      encodeCMunTable([
        { cepInicial: 1_000_000, cepFinal: 1_099_999, cMun: 3_550_308 },
        { cepInicial: 1_050_000, cepFinal: 1_199_999, cMun: 3_304_557 },
      ]),
    ).toThrow(CMunTableError);
  });

  it('refuses to encode unsorted ranges', () => {
    expect(() =>
      encodeCMunTable([
        { cepInicial: 2_000_000, cepFinal: 2_099_999, cMun: 3_304_557 },
        { cepInicial: 1_000_000, cepFinal: 1_099_999, cMun: 3_550_308 },
      ]),
    ).toThrow(CMunTableError);
  });

  it('refuses to encode an inverted range', () => {
    expect(() =>
      encodeCMunTable([{ cepInicial: 1_099_999, cepFinal: 1_000_000, cMun: 3_550_308 }]),
    ).toThrow(CMunTableError);
  });
});
