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
    expect(zpl).toContain(`^FD${CHAVE}^FS`); // chave fed to the barcode
    expect(zpl).toContain('DANFE SIMPLIFICADO - ETIQUETA');
    expect(zpl).toContain('SEM VALOR FISCAL'); // tpAmb=2
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
