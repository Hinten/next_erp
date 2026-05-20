import { describe, it, expect } from 'vitest';
import { NFeXsdValidationError, supportedRoots, validateXsd } from './index';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

describe('supportedRoots', () => {
  it('covers every SEFAZ root Phase A talks to', () => {
    const roots = supportedRoots();
    expect(roots).toEqual(
      expect.arrayContaining([
        'enviNFe',
        'consReciNFe',
        'consSitNFe',
        'consStatServ',
        'inutNFe',
        'NFe',
        'retEnviNFe',
        'retConsReciNFe',
        'retConsSitNFe',
        'retConsStatServ',
        'retInutNFe',
      ]),
    );
  });
});

describe('validateXsd — consStatServ', () => {
  it('accepts a valid consStatServ payload', async () => {
    const xml =
      `<consStatServ xmlns="${NFE_NS}" versao="4.00">` +
      `<tpAmb>2</tpAmb><cUF>35</cUF><xServ>STATUS</xServ>` +
      `</consStatServ>`;
    await expect(validateXsd('consStatServ', xml)).resolves.toBeUndefined();
  });

  it('rejects a tpAmb outside the {1,2} enum', async () => {
    const xml =
      `<consStatServ xmlns="${NFE_NS}" versao="4.00">` +
      `<tpAmb>9</tpAmb><cUF>35</cUF><xServ>STATUS</xServ>` +
      `</consStatServ>`;
    await expect(validateXsd('consStatServ', xml)).rejects.toBeInstanceOf(
      NFeXsdValidationError,
    );
  });

  it('rejects a missing required field (cUF)', async () => {
    const xml =
      `<consStatServ xmlns="${NFE_NS}" versao="4.00">` +
      `<tpAmb>2</tpAmb><xServ>STATUS</xServ>` +
      `</consStatServ>`;
    await expect(validateXsd('consStatServ', xml)).rejects.toBeInstanceOf(
      NFeXsdValidationError,
    );
  });

  it('rejects a wrong-namespace document', async () => {
    const xml =
      `<consStatServ xmlns="http://wrong/namespace" versao="4.00">` +
      `<tpAmb>2</tpAmb><cUF>35</cUF><xServ>STATUS</xServ>` +
      `</consStatServ>`;
    await expect(validateXsd('consStatServ', xml)).rejects.toBeInstanceOf(
      NFeXsdValidationError,
    );
  });
});

describe('validateXsd — consSitNFe', () => {
  it('accepts a valid consSitNFe payload', async () => {
    const xml =
      `<consSitNFe xmlns="${NFE_NS}" versao="4.00">` +
      `<tpAmb>2</tpAmb><xServ>CONSULTAR</xServ>` +
      `<chNFe>35200714200166000187550010000000071000000017</chNFe>` +
      `</consSitNFe>`;
    await expect(validateXsd('consSitNFe', xml)).resolves.toBeUndefined();
  });

  it('rejects a chNFe of wrong length (43 instead of 44)', async () => {
    const xml =
      `<consSitNFe xmlns="${NFE_NS}" versao="4.00">` +
      `<tpAmb>2</tpAmb><xServ>CONSULTAR</xServ>` +
      `<chNFe>3520071420016600018755001000000007100000001</chNFe>` +
      `</consSitNFe>`;
    await expect(validateXsd('consSitNFe', xml)).rejects.toBeInstanceOf(
      NFeXsdValidationError,
    );
  });
});

describe('NFeXsdValidationError', () => {
  it('carries the rootKey and the error list', async () => {
    const badXml =
      `<consStatServ xmlns="${NFE_NS}" versao="4.00"><tpAmb>9</tpAmb><cUF>35</cUF><xServ>STATUS</xServ></consStatServ>`;
    try {
      await validateXsd('consStatServ', badXml);
      throw new Error('expected validateXsd to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NFeXsdValidationError);
      const e = err as NFeXsdValidationError;
      expect(e.rootKey).toBe('consStatServ');
      expect(e.errors.length).toBeGreaterThan(0);
      expect(e.errors[0]?.message).toBeTruthy();
    }
  });
});
