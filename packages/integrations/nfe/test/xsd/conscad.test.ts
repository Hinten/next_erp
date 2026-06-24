import { describe, it, expect } from 'vitest';

import { NFeXsdValidationError, validateConsCad } from '../../src/xsd/index';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
// Request root is `ConsCad` with a CAPITAL C (SEFAZ quirk — the schema file is
// lowercase consCad_v2.00.xsd but the element it declares is `ConsCad`).
const consCad = (inner: string): string =>
  `<ConsCad versao="2.00" xmlns="${NFE_NS}">${inner}</ConsCad>`;

describe('validateConsCad', () => {
  it('accepts a well-formed ConsCad (xServ/UF/CNPJ)', async () => {
    await expect(
      validateConsCad(
        consCad('<infCons><xServ>CONS-CAD</xServ><UF>SP</UF><CNPJ>14200166000187</CNPJ></infCons>'),
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts the IE choice variant', async () => {
    await expect(
      validateConsCad(
        consCad('<infCons><xServ>CONS-CAD</xServ><UF>SP</UF><IE>111111111111</IE></infCons>'),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a bad xServ enumeration', async () => {
    await expect(
      validateConsCad(
        consCad('<infCons><xServ>NOPE</xServ><UF>SP</UF><CNPJ>14200166000187</CNPJ></infCons>'),
      ),
    ).rejects.toBeInstanceOf(NFeXsdValidationError);
  });

  it('rejects a missing versao attribute', async () => {
    await expect(
      validateConsCad(
        `<ConsCad xmlns="${NFE_NS}"><infCons><xServ>CONS-CAD</xServ><UF>SP</UF><CNPJ>14200166000187</CNPJ></infCons></ConsCad>`,
      ),
    ).rejects.toBeInstanceOf(NFeXsdValidationError);
  });

  it('rejects the lowercase root element (consCad — the bug that caused 215)', async () => {
    await expect(
      validateConsCad(
        `<consCad versao="2.00" xmlns="${NFE_NS}"><infCons><xServ>CONS-CAD</xServ><UF>SP</UF><CNPJ>14200166000187</CNPJ></infCons></consCad>`,
      ),
    ).rejects.toBeInstanceOf(NFeXsdValidationError);
  });
});
