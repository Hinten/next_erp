/**
 * `lerItensDoProc` (`@delfrance/schemas`) against the REAL writer: the
 * generator's det serialization wrapped by `buildNFeProc`, exactly the bytes
 * `apps/nfe` persists as `xml_nfe_proc`. The reader is a regex, so it is the
 * serializer's escaping, element order and attribute quoting this pins — a
 * devolução that cannot read its origin's lines references nothing (#1683).
 */
import { describe, expect, it } from 'vitest';
import { lerItensDoProc } from '@delfrance/schemas';

import { generateNFe } from '../../src/generator';
import { buildNFeProc } from '../../src/nfeproc';
import { buildHomologacaoFixture } from '../helpers/homologacao-fixture';

function procDe(itens: Parameters<typeof buildHomologacaoFixture>[0]['itens']): string {
  const out = generateNFe(
    buildHomologacaoFixture({
      numeracao: 1,
      serie: 4,
      cnpj: '99999999000191',
      ie: '111111111',
      itens,
    }),
  );
  return buildNFeProc(out.nfeXml, {
    infProt: {
      tpAmb: '2',
      verAplic: 'SP_NFE_PL009_V4',
      chNFe: out.chave,
      dhRecbto: '2026-10-07T10:00:00-03:00',
      nProt: '135260000000001',
      digVal: 'AbCdEf1234567890==',
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
    },
    versao: '4.00',
  });
}

describe('lerItensDoProc over a generated <nfeProc>', () => {
  it('reads every det the generator wrote: nItem, cProd, price and unit', () => {
    const itens = lerItensDoProc(
      procDe([
        { cProd: 'SKU-A', vUnCom: 1500 },
        { cProd: 'SKU-B', vUnCom: 49.99 },
      ]),
    );
    expect(itens?.map((i) => [i.nItem, i.cProd, i.vUnCom, i.uCom, i.qCom])).toEqual([
      [1, 'SKU-A', 1500, 'UN', 1],
      [2, 'SKU-B', 49.99, 'UN', 1],
    ]);
  });

  it('round-trips a cProd the serializer must escape (& and <) back to the stored sku', () => {
    const xml = procDe([{ cProd: 'A&B<1>', vUnCom: 10 }]);
    expect(xml).toContain('<cProd>A&amp;B&lt;1&gt;</cProd>');
    expect(lerItensDoProc(xml)?.[0]?.cProd).toBe('A&B<1>');
  });

  it('never reads the pag group or an item reference as a line', () => {
    const xml = procDe([
      { cProd: 'SKU-A', vUnCom: 10 },
      {
        cProd: 'SKU-B',
        vUnCom: 20,
        dfeReferenciado: { chaveAcesso: '35260599999999000191550010000000011000000010', nItem: 7 },
      },
    ]);
    expect(xml).toContain('<detPag>');
    expect(lerItensDoProc(xml)?.map((i) => i.nItem)).toEqual([1, 2]);
  });
});
