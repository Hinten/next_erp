import { describe, it, expect } from 'vitest';
import {
  serialize,
  parse,
  parseConsCad,
  NFeXmlError,
  namespacesNaoDeclarados,
  rootElementName,
  sliceElements,
  textOfFirst,
  type XmlValue,
} from '../../src/xml/index';
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

describe('sliceElements — signed parts stay bytes (#1094 F1b)', () => {
  it('returns each match as the EXACT input slice — attributes, entities and spacing untouched', () => {
    const a = '<item  id="1"	a="x">Peso &amp; volume</item>';
    const b = '<item id="2"/>';
    expect(sliceElements(`<?xml version="1.0"?><root>${a}<outro/>${b}</root>`, 'item')).toEqual([
      a,
      b,
    ]);
  });

  it('matches on the local name, so a namespace prefix does not hide an element', () => {
    const x = '<ns2:item xmlns:ns2="urn:x">1</ns2:item>';
    expect(sliceElements(`<root>${x}</root>`, 'item')).toEqual([x]);
  });

  it('reports an outer match once — not the same-named element nested inside it', () => {
    const outer = '<item><item>inner</item></item>';
    expect(sliceElements(`<root>${outer}</root>`, 'item')).toEqual([outer]);
  });

  it('skips a match that truncated input left unclosed, and finds none in an empty reply', () => {
    expect(sliceElements('<root><item>1</item><item>2', 'item')).toEqual(['<item>1</item>']);
    expect(sliceElements('<root/>', 'item')).toEqual([]);
  });
});

describe('rootElementName', () => {
  it('names the document element past the prolog and comments, without its prefix', () => {
    expect(rootElementName('<?xml version="1.0"?><!-- c --><procEventoNFe/>')).toBe(
      'procEventoNFe',
    );
    expect(rootElementName('<n:retEnvEvento xmlns:n="urn:x"/>')).toBe('retEnvEvento');
    expect(rootElementName('')).toBeNull();
  });
});

describe('textOfFirst', () => {
  it('unescapes exactly once', () => {
    expect(textOfFirst('<d><x>a &amp; b &lt;c&gt;</x></d>', 'x')).toBe('a & b <c>');
    // Near-miss: an escaped entity stays one level escaped — never double-decoded.
    expect(textOfFirst('<d><x>&amp;lt;</x></d>', 'x')).toBe('&lt;');
  });

  it('is null when the element is absent', () => {
    expect(textOfFirst('<d/>', 'x')).toBeNull();
  });

  it('decodes numeric character references in the same single pass', () => {
    expect(textOfFirst('<d><x>Corre&#231;&#xE3;o 2&#215;3</x></d>', 'x')).toBe('Correção 2×3');
    // Near-misses: an escaped reference is decoded ONCE; an impossible one is kept.
    expect(textOfFirst('<d><x>&amp;#231;</x></d>', 'x')).toBe('&#231;');
    expect(textOfFirst('<d><x>&#x110000;</x></d>', 'x')).toBe('&#x110000;');
  });

  it('keeps CDATA literal — its "&amp;" is text, not an entity', () => {
    expect(textOfFirst('<d><x><![CDATA[a &amp; <b>]]></x></d>', 'x')).toBe('a &amp; <b>');
  });
});

describe('parser edges the byte-exact helpers rely on', () => {
  it('a quoted ">" or "/>" inside an attribute neither ends nor self-closes the tag', () => {
    const p = '<p><q a="x/>"></q><r b="1>2">t</r></p>';
    expect(sliceElements(`<root>${p}<s/></root>`, 'p')).toEqual([p]);
    expect(textOfFirst(p, 'r')).toBe('t');
  });

  it('a stray close tag is ignored instead of crashing the parse', () => {
    expect(rootElementName('</a><b/>')).toBe('b');
  });

  it('parse() now decodes a character reference SEFAZ sends in a text field', () => {
    const xml =
      '<retConsStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' +
      '<tpAmb>2</tpAmb><verAplic>SP</verAplic><cStat>107</cStat>' +
      '<xMotivo>Servi&#231;o em Opera&#xE7;&#xE3;o</xMotivo><cUF>35</cUF>' +
      '<dhRecbto>2026-09-29T10:00:00-03:00</dhRecbto></retConsStatServ>';
    expect(parse<XmlValue>('retConsStatServ', xml).xMotivo).toBe('Serviço em Operação');
  });
});

describe('namespacesNaoDeclarados — what a slice inherited', () => {
  it('nothing, when the fragment declares what it uses', () => {
    expect(namespacesNaoDeclarados('<p xmlns="u" xmlns:ds="d"><c/><ds:s/></p>')).toEqual({
      padrao: false,
      prefixos: [],
    });
  });

  it('the default namespace, when an unprefixed element has none in scope', () => {
    expect(namespacesNaoDeclarados('<p><c/></p>').padrao).toBe(true);
    expect(namespacesNaoDeclarados('<n:p xmlns:n="u"><c/></n:p>').padrao).toBe(true);
    // An explicit `xmlns=""` is a declaration (no namespace, on purpose).
    expect(namespacesNaoDeclarados('<n:p xmlns:n="u"><c xmlns=""/></n:p>').padrao).toBe(false);
    // Unprefixed ATTRIBUTES are in no namespace, so they never need one.
    expect(namespacesNaoDeclarados('<n:p xmlns:n="u" a="1"/>').padrao).toBe(false);
  });

  it('a prefix, scope-aware — a declaration on a sibling does not cover it', () => {
    expect(
      namespacesNaoDeclarados('<p xmlns="u"><a xmlns:ds="d"><ds:x/></a><ds:y/><e ds:z="1"/></p>')
        .prefixos,
    ).toEqual(['ds']);
    expect(namespacesNaoDeclarados('<p xmlns="u" xml:lang="pt"/>').prefixos).toEqual([]);
  });

  it('reads a declaration that follows a quoted ">"', () => {
    expect(namespacesNaoDeclarados('<p foo="a>b" xmlns="u"><c/></p>').padrao).toBe(false);
  });
});
