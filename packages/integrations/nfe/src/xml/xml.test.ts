import { describe, it, expect } from 'vitest';
import { serialize, parse, NFeXmlError, type XmlValue } from './index';

describe('serialize', () => {
  it('builds an element in xs:sequence order with the NF-e namespace', () => {
    const xml = serialize('consStatServ', {
      tpAmb: '2',
      cUF: '35',
      xServ: 'STATUS',
      versao: '4.00',
    });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(
      '<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">',
    );
    expect(xml).toContain('<tpAmb>2</tpAmb><cUF>35</cUF><xServ>STATUS</xServ>');
  });

  it('emits no formatting whitespace between tags', () => {
    const xml = serialize('consStatServ', { tpAmb: '2', cUF: '35', xServ: 'STATUS', versao: '4.00' });
    expect(xml).not.toMatch(/>\s+</);
  });

  it('omits absent optional fields', () => {
    const xml = serialize('retConsStatServ', {
      tpAmb: '2',
      verAplic: 'v1',
      cStat: '107',
      xMotivo: 'Servico em Operacao',
      cUF: '35',
      dhRecbto: '2026-05-19T10:00:00-03:00',
      versao: '4.00',
    });
    expect(xml).not.toContain('<tMed>');
    expect(xml).not.toContain('<xObs>');
  });
});

describe('parse', () => {
  it('round-trips a document through serialize and parse', () => {
    const original: XmlValue = {
      tpAmb: '2',
      verAplic: 'SP_NFE_PL_009_V400',
      cStat: '107',
      xMotivo: 'Servico em Operacao',
      cUF: '35',
      dhRecbto: '2026-05-19T10:00:00-03:00',
      versao: '4.00',
    };
    expect(parse('retConsStatServ', serialize('retConsStatServ', original))).toEqual(original);
  });

  it('escapes on serialize and unescapes on parse', () => {
    const xml = serialize('retConsStatServ', {
      tpAmb: '2',
      verAplic: 'v1',
      cStat: '999',
      xMotivo: 'A & B < C > D',
      cUF: '35',
      dhRecbto: '2026-05-19T10:00:00-03:00',
      versao: '4.00',
    });
    expect(xml).toContain('<xMotivo>A &amp; B &lt; C &gt; D</xMotivo>');
    expect(parse<XmlValue>('retConsStatServ', xml).xMotivo).toBe('A & B < C > D');
  });

  it('throws NFeXmlError when the root element is missing', () => {
    expect(() => parse('retConsStatServ', '<other/>')).toThrow(NFeXmlError);
  });
});
