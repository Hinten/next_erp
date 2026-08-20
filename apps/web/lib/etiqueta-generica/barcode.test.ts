import { describe, expect, it } from 'vitest';

import { encodeCode128C } from './barcode';
import { CHAVE } from './fixtures';

describe('encodeCode128C', () => {
  it('encodes start-C, the digit pairs, the checksum and the stop', () => {
    // '1234' → START C(105), 12, 34, checksum, STOP.
    // checksum = (105 + 12×1 + 34×2) % 103 = 185 % 103 = 82.
    const symbol = encodeCode128C('1234');
    // (start + 2 data + checksum) × 11 modules + the 13-module stop.
    expect(symbol?.modules).toBe(4 * 11 + 13);

    // START C is pattern '211232': bar 2, space 1, bar 1, space 2, bar 3, space 2.
    expect(symbol?.bars.slice(0, 3)).toEqual([
      { start: 0, width: 2 },
      { start: 3, width: 1 },
      { start: 6, width: 3 },
    ]);

    // The checksum symbol (value 82 → '121241') is the 4th of the five symbols,
    // so it starts at module 3 × 11 = 33: bar 1, space 2, bar 1, space 2, bar 4.
    expect(symbol?.bars.filter((b) => b.start >= 33 && b.start < 44)).toEqual([
      { start: 33, width: 1 },
      { start: 36, width: 1 },
      { start: 39, width: 4 },
    ]);
  });

  it('packs the 44-digit NF-e chave into 22 subset-C symbols', () => {
    // (1 start + 22 data + 1 checksum) × 11 + 13 stop.
    expect(encodeCode128C(CHAVE)?.modules).toBe(24 * 11 + 13);
  });

  it('keeps the pattern table intact — every symbol value 00–99 is 11 modules wide', () => {
    // Table-integrity check through the public API: a payload hitting every
    // subset-C data value, so a mistyped or misplaced row shows up as a wrong
    // total instead of an unscannable label nobody notices until the carrier
    // rejects it.
    const allValues = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0')).join('');
    expect(encodeCode128C(allValues)?.modules).toBe((1 + 100 + 1) * 11 + 13);
  });

  it('every bar is a positive width inside the symbol', () => {
    const symbol = encodeCode128C(CHAVE);
    expect(symbol).not.toBeNull();
    for (const bar of symbol!.bars) {
      expect(bar.width).toBeGreaterThan(0);
      expect(bar.start + bar.width).toBeLessThanOrEqual(symbol!.modules);
    }
  });

  it('refuses what subset C cannot represent instead of encoding it wrong', () => {
    expect(encodeCode128C('123')).toBeNull(); // odd length
    expect(encodeCode128C('12A4')).toBeNull(); // not a digit
    expect(encodeCode128C('')).toBeNull();
  });
});
