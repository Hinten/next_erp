/**
 * DANFE contingency note — a tpEmis ≠ 1 NF-e must print its `dhCont` +
 * `xJust` (MOC Anexo III). The note rides INFORMAÇÕES COMPLEMENTARES on the
 * A4 renderers and the "Dados adicionais" block on the simplificado.
 */
import { describe, expect, it } from 'vitest';

import { parseProcNFe } from '../../src/danfe/model';
import { composeInfoComplementares, contingencyNote } from '../../src/danfe/pdf/a4-common';
import { renderRetrato } from '../../src/danfe/pdf/retrato';
import { renderSimplificado } from '../../src/danfe/pdf/simplificado';
import { PROCNFE_FIXTURE } from './fixtures';
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
