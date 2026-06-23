import { describe, it, expect } from 'vitest';

import { NFeXsdValidationError, validateConsCad } from '../../src/xsd/index';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const consCad = (inner: string): string =>
  `<consCad versao="2.00" xmlns="${NFE_NS}">${inner}</consCad>`;

describe('validateConsCad', () => {
  it('accepts a well-formed consCad (xServ/UF/CNPJ)', async () => {
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
        `<consCad xmlns="${NFE_NS}"><infCons><xServ>CONS-CAD</xServ><UF>SP</UF><CNPJ>14200166000187</CNPJ></infCons></consCad>`,
      ),
    ).rejects.toBeInstanceOf(NFeXsdValidationError);
  });

  it('rejects the wrong root element name (ConsCad vs consCad)', async () => {
    await expect(
      validateConsCad(
        `<ConsCad versao="2.00" xmlns="${NFE_NS}"><infCons><xServ>CONS-CAD</xServ><UF>SP</UF><CNPJ>14200166000187</CNPJ></infCons></ConsCad>`,
      ),
    ).rejects.toBeInstanceOf(NFeXsdValidationError);
  });
});
