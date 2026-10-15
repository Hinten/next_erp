import { describe, expect, it } from 'vitest';

import { lerItensDoProc } from './nfeProc';

/** One `<det>` the way the generator serializes it (unprefixed, double-quoted). */
function det(
  nItem: number | string,
  p: { cProd?: string; xProd?: string; uCom?: string; qCom?: string; vUnCom?: string } = {},
  extra = '',
): string {
  return (
    `<det nItem="${nItem}"><prod>` +
    `<cProd>${p.cProd ?? `SKU-${nItem}`}</cProd><cEAN>SEM GTIN</cEAN>` +
    `<xProd>${p.xProd ?? `Produto ${nItem}`}</xProd><NCM>61099000</NCM><CFOP>5102</CFOP>` +
    `<uCom>${p.uCom ?? 'UN'}</uCom><qCom>${p.qCom ?? '1.0000'}</qCom>` +
    `<vUnCom>${p.vUnCom ?? '10.0000000000'}</vUnCom><vProd>10.00</vProd>` +
    `</prod><imposto><vTotTrib>0.00</vTotTrib></imposto>${extra}</det>`
  );
}

/** An `<nfeProc>` around the given dets, with the siblings a real one carries. */
function proc(dets: string, prefixo = ''): string {
  const p = prefixo === '' ? '' : `${prefixo}:`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><${p}nfeProc versao="4.00"><${p}NFe>` +
    `<${p}infNFe Id="NFe35261099999999000191550040000000011000000017" versao="4.00">` +
    `<${p}ide><${p}tpAmb>2</${p}tpAmb></${p}ide>${dets}` +
    `<${p}pag><${p}detPag><${p}tPag>17</${p}tPag><${p}vPag>10.00</${p}vPag></${p}detPag></${p}pag>` +
    `</${p}infNFe></${p}NFe><${p}protNFe><${p}infProt><${p}nProt>135260000000001</${p}nProt>` +
    `</${p}infProt></${p}protNFe></${p}nfeProc>`
  );
}

describe('lerItensDoProc', () => {
  it('reads every det in document order, with the attribute nItem', () => {
    const itens = lerItensDoProc(proc(det(1, { cProd: 'A' }) + det(2, { cProd: 'B' })));
    expect(itens).toEqual([
      { nItem: 1, cProd: 'A', xProd: 'Produto 1', uCom: 'UN', qCom: 1, vUnCom: 10 },
      { nItem: 2, cProd: 'B', xProd: 'Produto 2', uCom: 'UN', qCom: 1, vUnCom: 10 },
    ]);
  });

  it('reads the two decimal widths SEFAZ allows for vUnCom (legacy 2, current 10)', () => {
    const itens = lerItensDoProc(
      proc(det(1, { vUnCom: '49.99' }) + det(2, { vUnCom: '49.9900000000', qCom: '2.5000' })),
    );
    expect(itens?.map((i) => [i.vUnCom, i.qCom])).toEqual([
      [49.99, 1],
      [49.99, 2.5],
    ]);
  });

  it('decodes XML entities in cProd/xProd (an escaped sku must still match)', () => {
    const itens = lerItensDoProc(
      proc(det(1, { cProd: 'A&amp;B&#45;1&#x2F;2', xProd: 'Camisa &quot;P&quot; &lt;azul&gt;' })),
    );
    expect(itens?.[0]?.cProd).toBe('A&B-1/2');
    expect(itens?.[0]?.xProd).toBe('Camisa "P" <azul>');
  });

  it('tolerates a namespace prefix on every element', () => {
    const prefixado = proc(det(1, { cProd: 'X' }), 'nfe').replace(
      /<(\/?)(det|prod|cProd|cEAN|xProd|NCM|CFOP|uCom|qCom|vUnCom|vProd|imposto|vTotTrib)([\s>])/g,
      '<$1nfe:$2$3',
    );
    expect(prefixado).toContain('<nfe:det nItem="1">');
    expect(lerItensDoProc(prefixado)?.map((i) => i.cProd)).toEqual(['X']);
  });

  it('accepts a single-quoted nItem and extra attributes on det', () => {
    const itens = lerItensDoProc(
      proc(det(1).replace('<det nItem="1">', "<det foo='x' nItem='1'>")),
    );
    expect(itens?.map((i) => i.nItem)).toEqual([1]);
  });

  it('never takes detPag / detExport / a DFeReferenciado nItem for a line', () => {
    const itens = lerItensDoProc(
      proc(
        det(
          1,
          {},
          '<DFeReferenciado><chaveAcesso>35260599999999000191550010000000011000000010</chaveAcesso><nItem>7</nItem></DFeReferenciado>',
        ).replace('</prod>', '<detExport><nDraw>1</nDraw></detExport></prod>'),
      ),
    );
    expect(itens).toHaveLength(1);
    expect(itens?.[0]?.nItem).toBe(1);
  });

  it('does not confuse cProd with cProdANP inside the comb group', () => {
    const xml = proc(
      det(1, { cProd: 'REAL' }).replace(
        '</prod>',
        '<comb><cProdANP>210203001</cProdANP></comb></prod>',
      ),
    );
    expect(lerItensDoProc(xml)?.[0]?.cProd).toBe('REAL');
  });

  describe('all or nothing — any unreadable line makes the whole list null', () => {
    it.each([
      ['no XML', null],
      ['a non-string', 42],
      ['an empty string', ''],
      ['no infNFe', '<nfeProc><protNFe/></nfeProc>'],
      ['no det at all', proc('')],
      ['a det without nItem', proc(det(1).replace(' nItem="1"', ''))],
      ['nItem 0', proc(det(0))],
      ['nItem 991', proc(det(991))],
      ['a repeated nItem', proc(det(1) + det(1))],
      ['a det without prod', proc('<det nItem="1"><imposto/></det>')],
      // A truncated document: the second det never closes, so the pattern skips
      // it — the opening count is what keeps line 1 from passing as the whole nota.
      ['an unclosed det', proc(`${det(1)}<det nItem="2"><prod><cProd>B</cProd>`)],
      ['an empty cProd', proc(det(1, { cProd: '' }))],
      ['a comma decimal', proc(det(1, { vUnCom: '10,50' }))],
      ['an unknown named entity', proc(det(1, { cProd: 'A&nbsp;B' }))],
      ['an out-of-range numeric entity', proc(det(1, { cProd: 'A&#x110000;' }))],
      ['one good line and one unreadable', proc(det(1) + det(2, { qCom: 'x' }))],
    ])('%s → null', (_rotulo, xml) => {
      expect(lerItensDoProc(xml)).toBeNull();
    });
  });
});
