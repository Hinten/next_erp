/**
 * NT 2025.002 §5.1 widened two SEFAZ response codes (#329):
 *   - `cStat` from 3 to **3 or 4** digits (`TStat` = `[0-9]{3,4}`) — the RTC
 *     rejections occupy the 4-digit range (e.g. 1115);
 *   - `nProt` from 15 to **15 or 17** digits (`TProt` = `[0-9]{15}|[0-9]{17}`).
 *
 * Both are vendored (`tiposBasico_v4.00.xsd`, and `tiposBasico_v1.03.xsd` for
 * the evento family), and every SEFAZ reply is XSD-validated before it is
 * parsed — so this file pins the widths at that gate, on every response root
 * that carries them, and pins `isCStat` to the same shape.
 *
 * ⚠️ Negative cases filter the error list to the element under test: a sample
 * could also fail for an unrelated reason, and "it failed" alone would then
 * prove nothing about the width.
 */
import { describe, expect, it } from 'vitest';

import { buildCancelamentoDetEvento } from '../../src/eventos/index';
import { isCStat } from '../../src/state/index';
import { NFeXsdValidationError, validateXsd, type XsdRootKey } from '../../src/xsd/index';

const NS = 'http://www.portalfiscal.inf.br/nfe';
const CHAVE = '35200714200166000187550010000000071000000018';
const DH = '2026-05-29T10:00:00-03:00';
const NPROT_15 = '135260000012345';
const NPROT_17 = '13526000000012345';

/** XSD errors raised on `<element>` (namespaced) for one document; [] if valid. */
async function errosEm(root: XsdRootKey, xml: string, element: string): Promise<string[]> {
  try {
    await validateXsd(root, xml);
    return [];
  } catch (err) {
    if (err instanceof NFeXsdValidationError) {
      return err.errors.map((e) => e.message).filter((m) => m.includes(`}${element}'`));
    }
    throw err;
  }
}

function protNFe(cStat: string, nProt: string): string {
  return (
    `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic>` +
    `<chNFe>${CHAVE}</chNFe><dhRecbto>${DH}</dhRecbto><nProt>${nProt}</nProt>` +
    `<digVal>YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4</digVal>` +
    `<cStat>${cStat}</cStat><xMotivo>Motivo de teste</xMotivo></infProt></protNFe>`
  );
}

/** One builder per response root that carries a cStat and a protocol. */
const COM_PROTOCOLO: Array<[XsdRootKey, (cStat: string, nProt: string) => string]> = [
  [
    'retEnviNFe',
    (cStat, nProt) =>
      `<retEnviNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>SP</verAplic>` +
      `<cStat>104</cStat><xMotivo>Lote processado</xMotivo><cUF>35</cUF>` +
      `<dhRecbto>${DH}</dhRecbto>${protNFe(cStat, nProt)}</retEnviNFe>`,
  ],
  [
    'retConsReciNFe',
    (cStat, nProt) =>
      `<retConsReciNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>SP</verAplic>` +
      `<nRec>351000000000123</nRec><cStat>104</cStat><xMotivo>Lote processado</xMotivo>` +
      `<cUF>35</cUF><dhRecbto>${DH}</dhRecbto>${protNFe(cStat, nProt)}</retConsReciNFe>`,
  ],
  [
    'retConsSitNFe',
    (cStat, nProt) =>
      `<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>SP</verAplic>` +
      `<cStat>100</cStat><xMotivo>Autorizado</xMotivo><cUF>35</cUF><dhRecbto>${DH}</dhRecbto>` +
      `<chNFe>${CHAVE}</chNFe>${protNFe(cStat, nProt)}</retConsSitNFe>`,
  ],
  [
    'retInutNFe',
    (cStat, nProt) =>
      `<retInutNFe xmlns="${NS}" versao="4.00">` +
      `<infInut Id="ID35261420016600018755009000000005000000012">` +
      `<tpAmb>2</tpAmb><verAplic>SP_NFE</verAplic><cStat>${cStat}</cStat>` +
      `<xMotivo>Inutilizacao de numero homologada</xMotivo>` +
      `<cUF>35</cUF><ano>26</ano><CNPJ>14200166000187</CNPJ><mod>55</mod>` +
      `<serie>9</serie><nNFIni>5</nNFIni><nNFFin>12</nNFFin>` +
      `<dhRecbto>${DH}</dhRecbto><nProt>${nProt}</nProt></infInut></retInutNFe>`,
  ],
  [
    'retEnvEvento',
    (cStat, nProt) =>
      `<retEnvEvento xmlns="${NS}" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb>` +
      `<verAplic>SP_EVENTOS</verAplic><cOrgao>35</cOrgao><cStat>128</cStat>` +
      `<xMotivo>Lote de Evento Processado</xMotivo><retEvento versao="1.00"><infEvento>` +
      `<tpAmb>2</tpAmb><verAplic>SP_EVENTOS</verAplic><cOrgao>35</cOrgao>` +
      `<cStat>${cStat}</cStat><xMotivo>Evento registrado</xMotivo>` +
      `<chNFe>${CHAVE}</chNFe><tpEvento>110111</tpEvento><xEvento>Cancelamento</xEvento>` +
      `<nSeqEvento>1</nSeqEvento><dhRegEvento>${DH}</dhRegEvento>` +
      `<nProt>${nProt}</nProt></infEvento></retEvento></retEnvEvento>`,
  ],
];

describe('response XSD gate — 4-digit cStat and 15/17-digit nProt are accepted', () => {
  describe.each(COM_PROTOCOLO)('%s', (root, build) => {
    it.each([
      ['100', NPROT_15],
      ['100', NPROT_17],
      ['1115', NPROT_15],
      ['1115', NPROT_17],
    ])('cStat %s + nProt %s', async (cStat, nProt) => {
      await expect(validateXsd(root, build(cStat, nProt))).resolves.toBeUndefined();
    });

    // Near-misses on each side of the legal widths — a 16-digit protocol is the
    // GAP between the two allowed ones, the case a `{15,17}` rewrite would let in.
    it.each(['12345', '10'])('rejects cStat %j on the cStat element', async (cStat) => {
      expect(await errosEm(root, build(cStat, NPROT_15), 'cStat')).not.toEqual([]);
    });
    it.each(['13526000000123', '1352600000012345', '135260000000123456'])(
      'rejects a %s-long nProt on the nProt element',
      async (nProt) => {
        expect(await errosEm(root, build('100', nProt), 'nProt')).not.toEqual([]);
      },
    );
  });

  it('a lote-level 4-digit cStat (retEnviNFe with no receipt) passes too', async () => {
    const xml =
      `<retEnviNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>SP</verAplic>` +
      `<cStat>1115</cStat><xMotivo>Rejeicao RTC</xMotivo><cUF>35</cUF>` +
      `<dhRecbto>${DH}</dhRecbto></retEnviNFe>`;
    await expect(validateXsd('retEnviNFe', xml)).resolves.toBeUndefined();
  });
});

describe('isCStat agrees with the XSD TStat facet', () => {
  const statServ = (cStat: string) =>
    `<retConsStatServ xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>SP</verAplic>` +
    `<cStat>${cStat}</cStat><xMotivo>Servico em Operacao</xMotivo><cUF>35</cUF>` +
    `<dhRecbto>${DH}</dhRecbto></retConsStatServ>`;

  // If a future schema pack moves `TStat` again, this reds until `isCStat`
  // follows it — the predicate must never drift from the gate it stands in for.
  it.each(['', '10', '100', '0100', '1115', '9999', '12345', 'abc'])('%j', async (cStat) => {
    const xsdAceita = (await errosEm('retConsStatServ', statServ(cStat), 'cStat')).length === 0;
    expect(isCStat(cStat)).toBe(xsdAceita);
  });
});

describe('outgoing cancelamento detEvento carries the stored nProt', () => {
  const withNs = (det: string) => det.replace('<detEvento', `<detEvento xmlns="${NS}"`);
  const XJUST = 'Cancelamento por erro de digitacao no pedido';

  it('accepts a 17-digit nProt', async () => {
    const det = withNs(buildCancelamentoDetEvento({ nProt: NPROT_17, xJust: XJUST }));
    await expect(validateXsd('detEvento', det)).resolves.toBeUndefined();
  });

  it('refuses a 16-digit nProt before anything is sent', async () => {
    const det = withNs(buildCancelamentoDetEvento({ nProt: '1352600000012345', xJust: XJUST }));
    expect(await errosEm('detEvento', det, 'nProt')).not.toEqual([]);
  });
});

/**
 * Known limit — SEFAZ's own schema, NOT ours to edit: the evento response's
 * `infEvento/@Id` is still `ID[0-9]{15}` (`leiauteEvento_v1.00.xsd`). If SEFAZ
 * ever echoes a 17-digit protocol there, our inbound gate refuses a reply for
 * an event it already registered; a cancel resend then recovers through 573.
 * This flips the day a schema pack widens it.
 */
describe('tripwire — retEvento/infEvento Id is still ID + 15 digits', () => {
  const comId = (id: string) =>
    `<retEnvEvento xmlns="${NS}" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb>` +
    `<verAplic>SP_EVENTOS</verAplic><cOrgao>35</cOrgao><cStat>128</cStat>` +
    `<xMotivo>Lote de Evento Processado</xMotivo><retEvento versao="1.00">` +
    `<infEvento Id="${id}"><tpAmb>2</tpAmb><verAplic>SP_EVENTOS</verAplic><cOrgao>35</cOrgao>` +
    `<cStat>135</cStat><xMotivo>Evento registrado</xMotivo><chNFe>${CHAVE}</chNFe>` +
    `<tpEvento>110111</tpEvento><xEvento>Cancelamento</xEvento><nSeqEvento>1</nSeqEvento>` +
    `<dhRegEvento>${DH}</dhRegEvento><nProt>${NPROT_17}</nProt></infEvento></retEvento></retEnvEvento>`;

  it('accepts ID + 15 digits', async () => {
    await expect(validateXsd('retEnvEvento', comId(`ID${NPROT_15}`))).resolves.toBeUndefined();
  });

  it('refuses ID + 17 digits', async () => {
    await expect(validateXsd('retEnvEvento', comId(`ID${NPROT_17}`))).rejects.toBeInstanceOf(
      NFeXsdValidationError,
    );
  });
});
