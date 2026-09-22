import { describe, expect, it } from 'vitest';

import { encodeCode128, MIN_MODULE_MM } from './barcode';
import { INNER_W_MM } from './layout';
import { ALFA_CHAVE, ALFA_ORDEM_CHAVE, CHAVE } from './fixtures';

describe('encodeCode128', () => {
  it('encodes start-C, the digit pairs, the checksum and the stop', () => {
    // '1234' → START C(105), 12, 34, checksum, STOP.
    // checksum = (105 + 12×1 + 34×2) % 103 = 185 % 103 = 82.
    const symbol = encodeCode128('1234');
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

  it('packs the all-numeric NF-e chave into 22 subset-C symbols', () => {
    // (1 start + 22 data + 1 checksum) × 11 + 13 stop. ⚠️ NON-REGRESSION: this
    // is the width every label printed before mixed subsets existed, so a
    // change here means every numeric label just moved.
    expect(encodeCode128(CHAVE)?.modules).toBe(24 * 11 + 13);
  });

  it('keeps the pattern table intact — every symbol value 00–99 is 11 modules wide', () => {
    // Table-integrity check through the public API: a payload hitting every
    // subset-C data value, so a mistyped or misplaced row shows up as a wrong
    // total instead of an unscannable label nobody notices until the carrier
    // rejects it.
    const allValues = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0')).join('');
    expect(encodeCode128(allValues)?.modules).toBe((1 + 100 + 1) * 11 + 13);
  });

  it('keeps the pattern table intact — every subset-B value is 11 modules wide', () => {
    // The sibling of the subset-C sweep above, and the half that was never
    // reachable before. Each printable ASCII character is encoded ALONE, so a
    // mistyped row shows up as this one character's wrong total rather than
    // being averaged away inside a long payload.
    for (let code = 32; code <= 126; code += 1) {
      const ch = String.fromCharCode(code);
      // START_B + 1 data + checksum, then the 13-module stop. Digits are the
      // exception: a lone digit is still one B symbol, so the count holds.
      expect(encodeCode128(ch)?.modules, `charCode ${code} (${ch})`).toBe(3 * 11 + 13);
    }
  });

  describe('an alphanumeric chave (NT 2026.004)', () => {
    it('encodes the worst case in mixed subsets rather than refusing it', () => {
      // START_C + 3 pairs + CODE_B + 12 letters + CODE_C + 13 pairs + checksum
      // = 32 symbols × 11 + the 13-module stop.
      const symbol = encodeCode128(ALFA_CHAVE);
      expect(symbol).not.toBeNull();
      expect(symbol!.modules).toBe(32 * 11 + 13);
    });

    it('is narrower when the CNPJ carries only an alfa ordem', () => {
      // The realistic shape: one letter, so C absorbs 16 leading digits and all
      // 26 trailing ones. Proves the segmentation is data-driven rather than
      // hardcoded to the chave's field layout.
      const symbol = encodeCode128(ALFA_ORDEM_CHAVE);
      expect(symbol!.modules).toBe(27 * 11 + 13);
      expect(symbol!.modules).toBeLessThan(encodeCode128(ALFA_CHAVE)!.modules);
    });

    it('stays above the scannable narrow-bar floor at the REAL maximum', () => {
      // ⚠️ Swept, not hand-picked. A floor test whose job is to fail when a
      // future layout narrows the barcode box is only worth anything if it is
      // evaluated at the widest symbol the label can actually be asked to
      // print — and a fixture is a guess at that, not a proof. This asserted
      // one fixture at first and was wrong by 11 modules: an alfa CNPJ whose
      // last letter sits at position 16 reached 376 modules (0.2394mm) while
      // ALFA_CHAVE sat at 365, so the guard was pinned to a symbol narrower
      // than reality.
      //
      // All 4096 letter/digit arrangements of the alfa window, which is the
      // whole space a real emitente CNPJ can occupy.
      let widest = 0;
      let worstChave = '';
      for (let mask = 0; mask < 4096; mask += 1) {
        let body = '';
        for (let bit = 0; bit < 12; bit += 1) body += (mask >> bit) & 1 ? 'A' : '7';
        const chave = `352601${body}87550010000001234567890120`;
        const symbol = encodeCode128(chave);
        expect(symbol, chave).not.toBeNull();
        if (symbol!.modules > widest) {
          widest = symbol!.modules;
          worstChave = chave;
        }
      }

      // The bound `fixtures.ts` and `barcode.ts` both claim, now executable.
      expect(widest, `widest arrangement was ${worstChave}`).toBe(365);
      // ALFA_CHAVE must keep TYING it, or the render fixtures stop exercising
      // the case the PDF assertions are supposed to cover.
      expect(encodeCode128(ALFA_CHAVE)!.modules).toBe(widest);

      const moduleMm = INNER_W_MM / widest;
      expect(moduleMm).toBeGreaterThan(MIN_MODULE_MM);
      // Under GS1's 0.250mm general-distribution nominal, over the ~0.19mm a
      // handheld needs.
      expect(moduleMm).toBeCloseTo(0.247, 3);
    });

    it('spills an odd trailing digit run from its head, not its tail', () => {
      // The arrangement that used to cost 11 extra modules: the last letter of
      // the CNPJ body sits at position 16, leaving a 27-digit run to the end.
      // Stranding its last digit paid a CODE_B switch to carry one character;
      // spilling the first lets it join the B segment already open.
      const chave = '352601A777A77777A787550010000001234567890120';
      expect(chave).toHaveLength(44);
      expect(encodeCode128(chave)!.modules).toBe(365);
    });
  });

  it('every bar is a positive width inside the symbol', () => {
    for (const data of [CHAVE, ALFA_CHAVE, ALFA_ORDEM_CHAVE]) {
      const symbol = encodeCode128(data);
      expect(symbol, data).not.toBeNull();
      for (const bar of symbol!.bars) {
        expect(bar.width).toBeGreaterThan(0);
        expect(bar.start + bar.width).toBeLessThanOrEqual(symbol!.modules);
      }
    }
  });

  it('handles an odd digit run by spilling one digit into subset B', () => {
    // '123' cannot pair up, so it is START_B + 3 chars + checksum — no longer
    // a refusal, which is what the subset-C-only encoder returned.
    expect(encodeCode128('123')?.modules).toBe(5 * 11 + 13);
  });

  it('refuses only a payload it genuinely cannot represent', () => {
    expect(encodeCode128('')).toBeNull();
    expect(encodeCode128('SÃO')).toBeNull(); // outside printable ASCII
    expect(encodeCode128('a\tb')).toBeNull(); // control character
  });
});
