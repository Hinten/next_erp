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
