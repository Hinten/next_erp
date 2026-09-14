import { describe, it, expect } from 'vitest';
import { serialize, parse, parseConsCad, NFeXmlError, type XmlValue } from '../../src/xml/index';
import { META as CONSCAD_META } from '../../src/types/conscad-schema';
import { META as NFE_META } from '../../src/types/nfe-schema';

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
    const xml = serialize('consStatServ', {
      tpAmb: '2',
      cUF: '35',
      xServ: 'STATUS',
      versao: '4.00',
    });
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

describe('parse on truncated input', () => {
  // Each case leaves a terminator unmatched. The parser used to add the -1 from
  // the failed scan to the cursor, move BACKWARDS and re-read earlier tags
  // forever — a synchronous spin, so no test timeout could even fire. Now it
  // stops and returns the tree it has.
  const OPEN = '<retConsStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">';
  it.each([
    ['comment', `${OPEN}<cStat>107</cStat><!-- truncado`],
    ['processing instruction', `${OPEN}<cStat>107</cStat><?pi truncado`],
    ['CDATA section', `${OPEN}<cStat>107</cStat><xMotivo><![CDATA[truncado`],
    ['markup declaration', `${OPEN}<cStat>107</cStat><!DOCTYPE truncado`],
  ])('stops at an unterminated %s and keeps what it read', (_label, xml) => {
    expect(parse<XmlValue>('retConsStatServ', xml).cStat).toBe('107');
  });
});

describe('Consulta Cadastro is a separate codegen pack', () => {
  // Both leiautes declare a `TEndereco`. One shared codegen run resolves that
  // name by file order, so one pack's address would silently become the
  // other's (issue #251). Pin that each pack kept its own.
  it('keeps the NF-e TEndereco in the NF-e META and the layout 2.00 one in its own', () => {
    expect(NFE_META.TEndereco?.map((d) => d.name)).toEqual(expect.arrayContaining(['UF', 'cPais']));
    expect(CONSCAD_META.TEndereco?.map((d) => d.name)).toEqual([
      'xLgr',
      'nro',
      'xCpl',
      'xBairro',
      'cMun',
      'xMun',
      'CEP',
    ]);
  });

  it('never registers one pack’s types in the other', () => {
    expect(Object.keys(NFE_META)).not.toContain('TRetConsCad');
    expect(Object.keys(CONSCAD_META)).not.toContain('TNFe');
  });

  it('parses only the elements layout 2.00 declares', () => {
    // `indCredNFCe` is not in the XSD (the real indicator is `indCredCTe`); a
    // tolerant walker would surface it, the META-driven parse must not.
    const ret = parseConsCad<XmlValue>(
      'retConsCad',
      '<retConsCad versao="2.00" xmlns="http://www.portalfiscal.inf.br/nfe"><infCons>' +
        '<cStat>111</cStat><infCad><IE>1</IE><indCredCTe>0</indCredCTe>' +
        '<indCredNFCe>1</indCredNFCe></infCad></infCons></retConsCad>',
    );
    const infCons = ret.infCons as XmlValue;
    const [cad] = infCons.infCad as XmlValue[];
    expect(cad).toEqual({ IE: '1', indCredCTe: '0' });
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
    expect(xml).toContain('<detEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">');
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
