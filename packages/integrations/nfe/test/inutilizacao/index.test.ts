import { describe, it, expect } from 'vitest';

import { buildInutNFe, NFeInutilizacaoError } from '../../src/inutilizacao/index';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const CNPJ = '14200166000187';

function baseInput() {
  return {
    cUF: '35',
    ano: '26',
    cnpj: CNPJ,
    serie: 9,
    nNFIni: 5,
    nNFFin: 12,
    xJust: 'Inutilizacao de faixa nao utilizada teste',
    tpAmb: '2' as const,
  };
}

describe('buildInutNFe', () => {
  it('builds the Id as ID + cUF(2) + ano(2) + CNPJ(14) + mod(2) + serie(3) + nNFIni(9) + nNFFin(9)', () => {
    const xml = buildInutNFe(baseInput());
    const expectedId = `ID3526${CNPJ}55009000000005000000012`;
    expect(xml).toContain(`<infInut Id="${expectedId}">`);
    // ID(2) + cUF(2) + ano(2) + cnpj(14) + mod(2) + serie(3) + ini(9) + fin(9) = 43.
    const id = /Id="(ID[^"]+)"/.exec(xml)![1]!;
    expect(id).toHaveLength(2 + 2 + 2 + 14 + 2 + 3 + 9 + 9);
  });

  it('throws NFeInutilizacaoError when nNFIni > nNFFin', () => {
    expect(() => buildInutNFe({ ...baseInput(), nNFIni: 20, nNFFin: 10 })).toThrow(
      NFeInutilizacaoError,
    );
  });

  it('emits the infInut children in XSD order', () => {
    const xml = buildInutNFe(baseInput());
    const order = [
      '<tpAmb>',
      '<xServ>',
      '<cUF>',
      '<ano>',
      '<CNPJ>',
      '<mod>',
      '<serie>',
      '<nNFIni>',
      '<nNFFin>',
      '<xJust>',
    ];
    let cursor = -1;
    for (const tag of order) {
      const at = xml.indexOf(tag);
      expect(at, `${tag} present`).toBeGreaterThan(-1);
      expect(at, `${tag} after previous`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('fixes xServ=INUTILIZAR and mod=55', () => {
    const xml = buildInutNFe(baseInput());
    expect(xml).toContain('<xServ>INUTILIZAR</xServ>');
    expect(xml).toContain('<mod>55</mod>');
  });

  it('emits serie + nNF element values as plain integers (the Id pads, the elements do not)', () => {
    const xml = buildInutNFe(baseInput());
    expect(xml).toContain('<serie>9</serie>');
    expect(xml).toContain('<nNFIni>5</nNFIni>');
    expect(xml).toContain('<nNFFin>12</nNFFin>');
  });

  it('XML-escapes the xJust', () => {
    const xml = buildInutNFe({
      ...baseInput(),
      xJust: 'Faixa & numeros <perdidos> da serie teste',
    });
    expect(xml).toContain('Faixa &amp; numeros &lt;perdidos&gt; da serie teste');
    expect(xml).not.toContain('<perdidos>');
  });

  it('wraps in the NFe namespace + versao 4.00', () => {
    const xml = buildInutNFe(baseInput());
    expect(xml).toMatch(new RegExp(`^<inutNFe xmlns="${NFE_NS}" versao="4.00">`));
    expect(xml.endsWith('</inutNFe>')).toBe(true);
  });
});
