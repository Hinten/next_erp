import { describe, it, expect } from 'vitest';
import { serialize, parse, NFeXmlError, type XmlValue } from '../../src/xml/index';

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

describe('ROOTS xmlName for tpEvento-keyed event payloads', () => {
  // The event detEvento METAs are keyed by tpEvento code
  // (`detEvento_e110110`/`_e110111`) to avoid a codegen collision, but the real
  // wire element is `<detEvento>`. The generated ROOTS must carry the real
  // xmlName so serialize/parse target the correct tag, not the synthetic key.
  it('serializes the synthetic key under the real <detEvento> tag', () => {
    const xml = serialize('detEvento_e110110', {
      versao: '1.00',
      descEvento: 'Carta de Correção',
      xCorrecao: 'Correcao de teste com ao menos quinze caracteres',
      xCondUso: 'texto fixo de condicoes de uso',
    });
    expect(xml).toContain(
      '<detEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">',
    );
    expect(xml).not.toContain('detEvento_e110110');
  });

  it('round-trips via parse on the same key', () => {
    const xml = serialize('detEvento_e110111', {
      versao: '1.00',
      descEvento: 'Cancelamento',
      nProt: '135200000012345',
      xJust: 'Cancelamento por erro de digitacao no pedido',
    });
    const parsed = parse<XmlValue>('detEvento_e110111', xml);
    expect(parsed.descEvento).toBe('Cancelamento');
    expect(parsed.nProt).toBe('135200000012345');
  });
});
