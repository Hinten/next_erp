/**
 * DANFE contingency note — a tpEmis ≠ 1 NF-e must print its `dhCont` +
 * `xJust` (MOC Anexo III). The note rides INFORMAÇÕES COMPLEMENTARES on the
 * A4 renderers and the "Dados adicionais" block on the simplificado.
 */
import { describe, expect, it } from 'vitest';

import { renderDanfeEpec } from '../../src/danfe/index';
import { parseNFeForEpec, parseProcNFe } from '../../src/danfe/model';
import { composeInfoComplementares, contingencyNote } from '../../src/danfe/pdf/a4-common';
import { renderRetrato } from '../../src/danfe/pdf/retrato';
import { renderSimplificado } from '../../src/danfe/pdf/simplificado';
import { CHAVE, PROCNFE_FIXTURE } from './fixtures';
import { isPdf, pageCount } from './helpers';

const XJUST = 'SEFAZ-SP indisponivel desde as 08h de hoje';

/** The fixture with its ide flipped to an SVC-AN contingency emission. */
const CONTINGENCIA_FIXTURE = PROCNFE_FIXTURE.replace(
  '<tpEmis>1</tpEmis>',
  '<tpEmis>6</tpEmis>',
).replace(
  '<verProc>erp-next 1.0</verProc>',
  `<verProc>erp-next 1.0</verProc><dhCont>2026-06-10T08:00:00-03:00</dhCont><xJust>${XJUST}</xJust>`,
);

describe('model — dhCont/xJust', () => {
  it('parses dhCont + xJust into DanfeIde', () => {
    const model = parseProcNFe(CONTINGENCIA_FIXTURE);
    expect(model.ide.tpEmis).toBe('6');
    expect(model.ide.dhCont).toBe('2026-06-10T08:00:00-03:00');
    expect(model.ide.xJust).toBe(XJUST);
  });

  it('leaves them null on a normal NF-e', () => {
    const model = parseProcNFe(PROCNFE_FIXTURE);
    expect(model.ide.dhCont).toBeNull();
    expect(model.ide.xJust).toBeNull();
  });
});

describe('contingencyNote', () => {
  it('builds the SVC-AN note with date, time and justification', () => {
    const note = contingencyNote(parseProcNFe(CONTINGENCIA_FIXTURE));
    expect(note).toContain('EMISSÃO EM CONTINGÊNCIA (SVC-AN)');
    expect(note).toContain('10/06/2026');
    expect(note).toContain('08:00:00');
    expect(note).toContain(`Justificativa: ${XJUST}`);
  });

  it('is null for normal emission', () => {
    expect(contingencyNote(parseProcNFe(PROCNFE_FIXTURE))).toBeNull();
  });

  it('leads the INFORMAÇÕES COMPLEMENTARES composition', () => {
    const composed = composeInfoComplementares(parseProcNFe(CONTINGENCIA_FIXTURE));
    expect(composed.startsWith('EMISSÃO EM CONTINGÊNCIA (SVC-AN)')).toBe(true);
  });
});

describe('renderers — contingency NF-e', () => {
  it('retrato renders a valid PDF for a tpEmis=6 NF-e', async () => {
    const pdf = await renderRetrato(parseProcNFe(CONTINGENCIA_FIXTURE), {});
    expect(isPdf(pdf)).toBe(true);
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(1);
  });

  it('simplificado renders a valid one-page PDF for a tpEmis=6 NF-e', async () => {
    const pdf = await renderSimplificado(parseProcNFe(CONTINGENCIA_FIXTURE), {});
    expect(isPdf(pdf)).toBe(true);
    expect(pageCount(pdf)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// EPEC (tpEmis=4, estado 'p') — the DANFE renders from the signed <NFe> + the
// registered EPEC's <procEventoNFe>; there is no <nfeProc> yet. The A4 layouts
// swap the autorização box for "PROTOCOLO DE AUTORIZAÇÃO DO EPEC".
// ---------------------------------------------------------------------------

/** The fixture's bare signed `<NFe>`, flipped to an EPEC (tpEmis=4) emission. */
const NFE_EPEC_FIXTURE = (() => {
  const nfe = /<NFe>[\s\S]*<\/NFe>/.exec(PROCNFE_FIXTURE)![0];
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    nfe.replace('<NFe>', '<NFe xmlns="http://www.portalfiscal.inf.br/nfe">')
  )
    .replace('<tpEmis>1</tpEmis>', '<tpEmis>4</tpEmis>')
    .replace(
      '<verProc>erp-next 1.0</verProc>',
      `<verProc>erp-next 1.0</verProc><dhCont>2026-06-11T08:00:00-03:00</dhCont><xJust>${XJUST}</xJust>`,
    );
})();

const EPEC_NPROT = '891260000012345';
const EPEC_DH_REG = '2026-06-11T08:31:02-03:00';

/** The archival procEventoNFe of the registered EPEC (AN retEvento). */
const EPEC_PROC_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
  <evento versao="1.00"><infEvento Id="ID110140${CHAVE}01"><cOrgao>91</cOrgao><tpAmb>2</tpAmb><CNPJ>14200166000187</CNPJ><chNFe>${CHAVE}</chNFe><dhEvento>2026-06-11T08:30:30-03:00</dhEvento><tpEvento>110140</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento></infEvento></evento>
  <retEvento versao="1.00"><infEvento>
    <tpAmb>2</tpAmb><verAplic>AN_EVENTOS</verAplic><cOrgao>91</cOrgao>
    <cStat>136</cStat><xMotivo>Evento registrado, mas nao vinculado a NF-e</xMotivo>
    <chNFe>${CHAVE}</chNFe><tpEvento>110140</tpEvento><xEvento>EPEC</xEvento>
    <nSeqEvento>1</nSeqEvento>
    <dhRegEvento>${EPEC_DH_REG}</dhRegEvento>
    <nProt>${EPEC_NPROT}</nProt>
  </infEvento></retEvento>
</procEventoNFe>`;

describe('parseNFeForEpec', () => {
  it('builds the model from the bare NFe + the EPEC protocolo (no nfeProc prot)', () => {
    const model = parseNFeForEpec(NFE_EPEC_FIXTURE, EPEC_PROC_FIXTURE);
    expect(model.chave).toBe(CHAVE);
    expect(model.ide.tpEmis).toBe('4');
    expect(model.ide.dhCont).toBe('2026-06-11T08:00:00-03:00');
    expect(model.ide.xJust).toBe(XJUST);
    expect(model.prot).toBeNull();
    expect(model.epec).toEqual({ nProt: EPEC_NPROT, dhRegEvento: EPEC_DH_REG });
  });

  it('degrades to null protocolo fields when the proc carries no retEvento', () => {
    const noRet = EPEC_PROC_FIXTURE.replace(/<retEvento[\s\S]*<\/retEvento>/, '');
    const model = parseNFeForEpec(NFE_EPEC_FIXTURE, noRet);
    expect(model.epec).toEqual({ nProt: null, dhRegEvento: null });
  });
});

describe('contingencyNote — EPEC', () => {
  it('labels the note EPEC and carries dhCont + xJust', () => {
    const note = contingencyNote(parseNFeForEpec(NFE_EPEC_FIXTURE, EPEC_PROC_FIXTURE));
    expect(note).toContain('EMISSÃO EM CONTINGÊNCIA (EPEC)');
    expect(note).toContain('11/06/2026');
    expect(note).toContain(`Justificativa: ${XJUST}`);
  });
});

describe('renderDanfeEpec', () => {
  it.each(['retrato', 'paisagem', 'simplificado'] as const)(
    'renders a valid %s PDF for an EPEC-approved NF-e',
    async (format) => {
      const pdf = await renderDanfeEpec(NFE_EPEC_FIXTURE, EPEC_PROC_FIXTURE, { format });
      expect(isPdf(pdf)).toBe(true);
      expect(pageCount(pdf)).toBeGreaterThanOrEqual(1);
    },
  );
});
