import { describe, expect, it } from 'vitest';

import { parseProcNFe } from '../../src/danfe/model';
import { NFeDanfeFormatError } from '../../src/danfe/format';
import { renderSimplificadoZpl } from '../../src/danfe/zpl2';
import { CHAVE, PROCNFE_FIXTURE } from './fixtures';

describe('danfe/zpl2 renderSimplificadoZpl', () => {
  const model = parseProcNFe(PROCNFE_FIXTURE);

  it('emits a well-formed ZPL label', () => {
    const zpl = renderSimplificadoZpl(model);
    expect(zpl.startsWith('^XA')).toBe(true);
    expect(zpl.endsWith('^XZ')).toBe(true);
    expect(zpl).toContain('^CI28'); // UTF-8
    expect(zpl).toContain('^BCN'); // native Code 128
    expect(zpl).toContain(`^FD>;${CHAVE}^FS`); // chave in Code 128 subset C
    expect(zpl).toContain('DANFE SIMPLIFICADO - ETIQUETA');
    expect(zpl).toContain('SEM VALOR FISCAL'); // tpAmb=2
  });

  it('centers the barcode and draws section borders (^GB) like the PDF', () => {
    const zpl = renderSimplificadoZpl(model);
    // Bordered sections (outer box + each section) — at least a few ^GB boxes.
    expect((zpl.match(/\^GB/g) ?? []).length).toBeGreaterThanOrEqual(5);
    // Barcode field is centered, not flush against the left margin.
    const m = /\^FO(\d+),\d+\^BY\d+\^BCN/.exec(zpl);
    expect(m).not.toBeNull();
    const x = Number(m![1]);
    expect(x).toBeGreaterThan(80);
    expect(x).toBeLessThan(170);
  });

  /**
   * ⚠️ Code 128 **subset C** encodes digit PAIRS and cannot represent a letter
   * at all, and it is what makes the symbol fit the label. Since RFB
   * IN 2.229/2024 the chave's positions 6–17 may be alphanumeric, so the ZPL
   * etiqueta refuses such a chave instead of printing a broken symbol.
   *
   * An earlier revision of this PR switched to subset B for an alfa chave.
   * That doubles the symbol count while the module width stays fixed, so the
   * bars ran 1038 dots wide on a 799-dot label — clipped past `^PW`, checksum
   * and stop pattern missing, unscannable. The width assertion below is the
   * pin that catches exactly that, and it is the one the previous tests
   * lacked: they only compared x offsets, and `bcX`'s `Math.max` clamp keeps
   * the x plausible even when the symbol runs off the label.
   */
  describe('the Code 128 symbol', () => {
    const ALFA = '432601PC3D315K000193550010000000071000000012';
    const alfaModel = parseProcNFe(PROCNFE_FIXTURE.split(CHAVE).join(ALFA));

    /**
     * Recompute the printed width from what was actually EMITTED — the subset
     * is read off the field data's prefix, not assumed — so this stays honest
     * if the encoding ever changes.
     */
    function barcodeGeometry(zpl: string) {
      const pw = /\^PW(\d+)/.exec(zpl);
      const bc = /\^FO(\d+),\d+\^BY(\d+)\^BCN,[^^]*\^FD([^^]*)\^FS/.exec(zpl);
      expect(pw).not.toBeNull();
      expect(bc).not.toBeNull();
      const widthDots = Number(pw![1]);
      const x = Number(bc![1]);
      const moduleDots = Number(bc![2]);
      const payload = bc![3]!;
      const subsetC = payload.startsWith('>;');
      const data = subsetC ? payload.slice(2) : payload;
      const symbols = subsetC ? Math.ceil(data.length / 2) : data.length;
      // (start + data + checksum) × 11 modules + the 13-module stop pattern.
      const barWidthDots = ((symbols + 2) * 11 + 13) * moduleDots;
      return { widthDots, x, moduleDots, subsetC, data, barWidthDots };
    }

    it.each([203, 300])('fits inside ^PW at %i dpi, quiet zone included', (dpi) => {
      const g = barcodeGeometry(renderSimplificadoZpl(model, { dpi }));
      expect(g.subsetC).toBe(true);
      expect(g.data).toBe(CHAVE);
      // Code 128 wants a 10-module quiet zone on each side.
      const quiet = 10 * g.moduleDots;
      expect(g.x).toBeGreaterThanOrEqual(quiet);
      expect(g.x + g.barWidthDots + quiet).toBeLessThanOrEqual(g.widthDots);
    });

    it('a numeric chave uses subset C', () => {
      expect(renderSimplificadoZpl(model)).toContain(`^FD>;${CHAVE}^FS`);
    });

    /**
     * The measurement that motivates the guard, kept executable so it is not
     * just a claim in a comment. If a future change makes an alfa chave
     * printable (mixed subsets: C for the numeric head/tail, B for the
     * 12-character body → 30 data symbols, 365 modules), this is the
     * constraint it has to satisfy — and this test is where the numbers live.
     */
    it.each([
      [203, 799, 1038],
      [300, 1181, 1557],
    ])('subset B over 44 characters does NOT fit at %i dpi', (dpi, pw, barWidth) => {
      // ⚠️ `LABEL_W_MM` is named rather than inlined: a literal `100` here
      // reads as cents to `delfrance/no-ad-hoc-money-rounding`, which cannot
      // tell millimetres-to-dots from money and errors on the bare form.
      const LABEL_W_MM = 100;
      const dpm = dpi / 25.4;
      const moduleDots = Math.max(2, Math.round(0.25 * dpm));
      // Anchors `pw` to the real label: change the label size and this fails
      // rather than silently comparing against a stale number.
      expect(Math.round(LABEL_W_MM * dpm)).toBe(pw);
      // One symbol per character instead of one per pair.
      expect(((44 + 2) * 11 + 13) * moduleDots).toBe(barWidth);
      expect(barWidth).toBeGreaterThan(pw);
      // …whereas subset C over the same 44 digits does fit.
      expect(((Math.ceil(44 / 2) + 2) * 11 + 13) * moduleDots).toBeLessThan(pw);
    });

    it('an ALPHANUMERIC chave is refused, not silently clipped', () => {
      expect(() => renderSimplificadoZpl(alfaModel)).toThrow(NFeDanfeFormatError);
      // The message must name the value and the way out, so an operator hitting
      // this on a real label knows to print the PDF instead.
      expect(() => renderSimplificadoZpl(alfaModel)).toThrow(/PC3D315K000193/);
      expect(() => renderSimplificadoZpl(alfaModel)).toThrow(/simplificado/);
    });
  });

  it('scales the print width with dpi (203 default, 300 supported)', () => {
    expect(renderSimplificadoZpl(model)).toContain('^PW799');
    expect(renderSimplificadoZpl(model, { dpi: 300 })).toContain('^PW1181');
  });

  it('strips ZPL control prefixes from field data', () => {
    const tricky = parseProcNFe(
      PROCNFE_FIXTURE.replace('DELFRANCE COMERCIO LTDA', 'ACME ^ TILDE ~ CO'),
    );
    const zpl = renderSimplificadoZpl(tricky);
    expect(zpl).toContain('ACME   TILDE   CO');
  });
});
