import { describe, expect, it } from 'vitest';

import { parseProcNFe } from '../../src/danfe/model';
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
   * at all — so the `>;` prefix that forces it is only available when this
   * particular chave happens to be all digits. Since RFB IN 2.229/2024 the
   * emitente CNPJ at positions 6–17 may be alphanumeric, and forcing subset C
   * over it produces an unencodable symbol on a fiscal label.
   *
   * The pair-and-near-miss: a numeric chave keeps subset C (and its narrower,
   * deterministic width), an alfa chave drops to subset B — and the centring
   * maths has to follow, or the label is centred for a symbol the printer
   * never emits.
   */
  describe('Code 128 subset selection', () => {
    const ALFA = '432601PC3D315K000193550010000000071000000012';
    const alfaModel = parseProcNFe(PROCNFE_FIXTURE.split(CHAVE).join(ALFA));

    const barcodeField = (zpl: string) =>
      /\^FO(\d+),\d+\^BY(\d+)\^BCN[^^]*\^FD([^^]*)\^FS/.exec(zpl);

    it('an ALPHANUMERIC chave drops the >; prefix and encodes whole', () => {
      const zpl = renderSimplificadoZpl(alfaModel);
      expect(zpl).toContain(`^FD${ALFA}^FS`);
      expect(zpl).not.toContain('>;');
      // The letters actually reach the symbol — this is what was dropped.
      expect(zpl).toContain('PC3D315K000193');
    });

    it('a NUMERIC chave still uses subset C', () => {
      expect(renderSimplificadoZpl(model)).toContain(`^FD>;${CHAVE}^FS`);
    });

    it('the barcode is wider in subset B, and still centered', () => {
      const numeric = barcodeField(renderSimplificadoZpl(model));
      const alfa = barcodeField(renderSimplificadoZpl(alfaModel));
      expect(numeric).not.toBeNull();
      expect(alfa).not.toBeNull();
      // Subset B spends one symbol per character instead of one per pair, so
      // the same 44-character chave starts further left once centered.
      expect(Number(alfa![1])).toBeLessThan(Number(numeric![1]));
      expect(Number(alfa![1])).toBeGreaterThan(0);
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
