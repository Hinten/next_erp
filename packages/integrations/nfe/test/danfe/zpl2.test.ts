import { describe, expect, it } from 'vitest';

import { parseProcNFe } from '../../src/danfe/model';
import { NFeDanfeFormatError } from '../../src/danfe/format';
import { renderSimplificadoZpl } from '../../src/danfe/zpl2';
import { ALFA_CHAVE, CHAVE, PROCNFE_ALFA_FIXTURE, PROCNFE_FIXTURE } from './fixtures';

describe('danfe/zpl2 renderSimplificadoZpl', () => {
  const model = parseProcNFe(PROCNFE_FIXTURE);
  const alfaModel = parseProcNFe(PROCNFE_ALFA_FIXTURE);

  it.each([203, 300])('keeps the numeric ZPL byte-identical at %i dpi', (dpi) => {
    expect(renderSimplificadoZpl(model, { dpi })).toMatchSnapshot();
  });

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

  describe('the Code 128 symbol', () => {
    function barcodeGeometry(zpl: string, modules: number) {
      const pw = /\^PW(\d+)/.exec(zpl);
      const bc = /\^FO(\d+),\d+\^BY(\d+)\^BCN,[^^]*\^FD([^^]*)\^FS/.exec(zpl);
      expect(pw).not.toBeNull();
      expect(bc).not.toBeNull();
      const widthDots = Number(pw![1]);
      const x = Number(bc![1]);
      const moduleDots = Number(bc![2]);
      const payload = bc![3]!;
      return { widthDots, x, moduleDots, payload, barWidthDots: modules * moduleDots };
    }

    it.each([
      { name: 'numeric', input: model, modules: 277 },
      { name: 'alphanumeric', input: alfaModel, modules: 365 },
    ])('$name chave fits inside ^PW with quiet zones at 203 and 300 dpi', ({ input, modules }) => {
      for (const dpi of [203, 300]) {
        const g = barcodeGeometry(renderSimplificadoZpl(input, { dpi }), modules);
        const quiet = 10 * g.moduleDots;
        expect(g.x).toBeGreaterThanOrEqual(quiet);
        expect(g.x + g.barWidthDots + quiet).toBeLessThanOrEqual(g.widthDots);
      }
    });

    it('keeps a numeric chave in the historical subset-C field', () => {
      const g = barcodeGeometry(renderSimplificadoZpl(model), 277);
      expect(g.payload).toBe(`>;${CHAVE}`);
    });

    it('prints an alphanumeric chave with the exact C/B/C invocation sequence', () => {
      const zpl = renderSimplificadoZpl(alfaModel);
      const g = barcodeGeometry(zpl, 365);
      expect(g.payload).toBe('>;352601>6ABCDEFGHIJKL>587550010000001234567890120');
      expect(zpl).toContain(ALFA_CHAVE.match(/.{1,4}/g)!.join(' '));
    });

    it('refuses a malformed chave rather than emitting a plausible wrong symbol', () => {
      expect(() => renderSimplificadoZpl({ ...model, chave: CHAVE.slice(0, -1) })).toThrow(
        NFeDanfeFormatError,
      );
    });

    it('refuses a mixed symbol when the requested density cannot carry its quiet zones', () => {
      expect(() => renderSimplificadoZpl(alfaModel, { dpi: 150 })).toThrow(/zonas de silêncio/);
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
