import { describe, expect, it } from 'vitest';

import { renderCartaCorrecao } from '../../src/danfe';
import { parseCceRetorno, parseProcNFe } from '../../src/danfe/model';
import { renderCce, type CceData } from '../../src/danfe/pdf/cce';
import { PROCNFE_FIXTURE } from './fixtures';
import { isPdf, pageCount } from './helpers';

/** A minimal `retEnvEvento` reply carrying a registrada (135) CC-e retEvento. */
const RET_ENV_EVENTO = (
  dhRegEvento = '2026-06-10T10:00:00-03:00',
  nProt = '135260000123456',
): string =>
  `<retEnvEvento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe">` +
  `<idLote>1</idLote><tpAmb>2</tpAmb><verAplic>SP_EVENTO</verAplic>` +
  `<cOrgao>35</cOrgao><cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>` +
  `<retEvento versao="1.00"><infEvento Id="ID11011035260514200166000187550010000000071000000018">` +
  `<tpAmb>2</tpAmb><verAplic>SP_EVENTO</verAplic><cOrgao>35</cOrgao>` +
  `<cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo>` +
  `<chNFe>35260514200166000187550010000000071000000018</chNFe>` +
  `<tpEvento>110110</tpEvento><xEvento>Carta de Correcao registrada</xEvento>` +
  `<nSeqEvento>2</nSeqEvento><dhRegEvento>${dhRegEvento}</dhRegEvento>` +
  `<nProt>${nProt}</nProt></infEvento></retEvento></retEnvEvento>`;

const baseCce: CceData = {
  xCorrecao: 'Correção do endereço de entrega: leia-se RUA NOVA, 100.',
  nProt: '135260000123456',
  nSeqEvento: 2,
  dhRegEvento: '2026-06-10T10:00:00-03:00',
};

describe('danfe/pdf cce (Carta de Correção, A4 landscape)', () => {
  const model = parseProcNFe(PROCNFE_FIXTURE);

  it('renders a non-trivial one-page landscape PDF', async () => {
    const pdf = await renderCce(model, baseCce);
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(2000);
    expect(pageCount(pdf)).toBe(1);
  });

  it('keeps a max-length (1000-char) correction on a single page', async () => {
    const pdf = await renderCce(model, { ...baseCce, xCorrecao: 'PALAVRA '.repeat(125) });
    expect(isPdf(pdf)).toBe(true);
    expect(pageCount(pdf)).toBe(1);
  });

  it('renders the homologação watermark variant without throwing', async () => {
    // The fixture is tpAmb=2 → model.homologacao true → "SEM VALOR FISCAL".
    expect(model.homologacao).toBe(true);
    expect(isPdf(await renderCce(model, baseCce, { cancelada: true }))).toBe(true);
  });

  it('renders even when dhRegEvento/nProt are missing (graceful "—")', async () => {
    const pdf = await renderCce(model, { ...baseCce, dhRegEvento: null, nProt: null });
    expect(isPdf(pdf)).toBe(true);
  });
});

describe('danfe/model parseCceRetorno', () => {
  it('extracts dhRegEvento / nProt / chNFe from a retEnvEvento reply', () => {
    const ret = parseCceRetorno(RET_ENV_EVENTO('2026-06-10T11:22:33-03:00', '135999'));
    expect(ret.dhRegEvento).toBe('2026-06-10T11:22:33-03:00');
    expect(ret.nProt).toBe('135999');
    expect(ret.chNFe).toBe('35260514200166000187550010000000071000000018');
  });

  it('returns nulls when the reply carried no retEvento (lote-level reject)', () => {
    const noEvento =
      `<retEnvEvento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe">` +
      `<idLote>1</idLote><tpAmb>2</tpAmb><cOrgao>35</cOrgao>` +
      `<cStat>492</cStat><xMotivo>Rejeicao: Lote sem evento</xMotivo></retEnvEvento>`;
    const ret = parseCceRetorno(noEvento);
    expect(ret).toEqual({ dhRegEvento: null, nProt: null, chNFe: null });
  });
});

describe('danfe renderCartaCorrecao (entry)', () => {
  it('parses the procNFe + retorno and renders the PDF', async () => {
    const pdf = await renderCartaCorrecao({
      procNFeXml: PROCNFE_FIXTURE,
      xmlRetorno: RET_ENV_EVENTO(),
      xCorrecao: 'Correção de teste.',
      nProt: '135260000123456',
      nSeqEvento: 1,
    });
    expect(isPdf(pdf)).toBe(true);
    expect(pageCount(pdf)).toBe(1);
  });
});
