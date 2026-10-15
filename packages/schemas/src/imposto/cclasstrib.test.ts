/**
 * RTC Anexo III — the vendored cClassTrib / CST IBS/CBS tables + the validator
 * (#333). Pure unit tests. They guard the structural rule, the soft
 * "not in table" signal, the picker helpers, and — because the data is
 * hand-transcribed — the integrity of every row.
 */
import { describe, expect, it } from 'vitest';

import {
  CCLASSTRIB_PROVENIENCIA,
  CCLASSTRIB_TABELA,
  CST_IBSCBS_CODES,
  CST_IBSCBS_LABELS,
  CST_IBSCBS_TABELA,
  IND_CCLASSTRIB,
  IND_CST_IBSCBS,
  TIPO_ALIQUOTA_RTC,
  cClassTribCodesForCst,
  cClassTribDescricao,
  cClassTribEntriesForCst,
  cClassTribEntry,
  cstClassTribStructurallyValid,
  cstIbsCbsEntry,
  validateCstClassTrib,
} from './cclasstrib';

describe('cstClassTribStructurallyValid', () => {
  it('accepts a well-formed pair whose cClassTrib starts with the CST', () => {
    expect(cstClassTribStructurallyValid('000', '000001')).toBe(true);
    // Structural only — a code the table does not know still passes.
    expect(cstClassTribStructurallyValid('200', '200099')).toBe(true);
  });

  it('rejects a first-3-digit mismatch', () => {
    expect(cstClassTribStructurallyValid('000', '410001')).toBe(false);
  });

  it('rejects malformed codes', () => {
    expect(cstClassTribStructurallyValid('00', '000001')).toBe(false); // CST too short
    expect(cstClassTribStructurallyValid('000', '0001')).toBe(false); // cClassTrib too short
    expect(cstClassTribStructurallyValid('000', '00000a')).toBe(false); // non-digit
  });
});

describe('validateCstClassTrib', () => {
  it('ok for a known, structurally valid pair — including every code #330 needs', () => {
    expect(validateCstClassTrib('000', '000001')).toEqual({ ok: true });
    for (const code of ['410030', '800001', '800002', '810001', '811001', '811002', '811003']) {
      expect(validateCstClassTrib(code.slice(0, 3), code), code).toEqual({ ok: true });
    }
  });

  it('cst-mismatch for a structural violation, whatever the table holds', () => {
    expect(validateCstClassTrib('000', '410001')).toEqual({ ok: false, reason: 'cst-mismatch' });
    expect(validateCstClassTrib('000', '00001')).toEqual({ ok: false, reason: 'cst-mismatch' });
    expect(validateCstClassTrib('0', '000001')).toEqual({ ok: false, reason: 'cst-mismatch' });
  });

  it('not-in-table for a structurally valid code the snapshot does not know', () => {
    // '000000' is the code SEFAZ answered 1023 ("cClassTrib inexistente") for.
    expect(cClassTribEntry('000000')).toBeNull();
    expect(validateCstClassTrib('000', '000000')).toEqual({ ok: false, reason: 'not-in-table' });
  });

  it('a code valid only for OTHER documents is not-in-table here (NF-e rows only)', () => {
    // 000002 (Exploração de via) exists in Anexo III but not for NF-e.
    expect(cClassTribEntry('000002')).toBeNull();
    expect(validateCstClassTrib('000', '000002')).toEqual({ ok: false, reason: 'not-in-table' });
  });
});

describe('lookups match the code EXACTLY — no trimming or padding', () => {
  it.each(['00001', '0000010', ' 000001', '000001 ', '1'])('%j is unknown', (code) => {
    expect(cClassTribEntry(code)).toBeNull();
    expect(cClassTribDescricao(code)).toBeNull();
  });

  it('the exact code is known', () => {
    expect(cClassTribDescricao('000001')).toMatch(/integralmente/);
  });

  it('null / empty resolve to null', () => {
    expect(cClassTribDescricao(null)).toBeNull();
    expect(cClassTribEntry('')).toBeNull();
    expect(cstIbsCbsEntry(null)).toBeNull();
    expect(cstIbsCbsEntry(' 000')).toBeNull();
  });
});

describe('picker helpers', () => {
  it('lists every CST, sorted, and keeps codes/labels in sync', () => {
    expect([...CST_IBSCBS_CODES]).toEqual([...Object.keys(CST_IBSCBS_LABELS)].sort());
    expect(CST_IBSCBS_CODES).toHaveLength(18);
  });

  it('suggests only the chosen CST family, and every row when CST is empty', () => {
    expect(cClassTribCodesForCst('410')).toContain('410030');
    for (const cst of CST_IBSCBS_CODES) {
      expect(cClassTribCodesForCst(cst).every((c) => c.startsWith(cst))).toBe(true);
    }
    expect(cClassTribCodesForCst('999')).toEqual([]);
    expect(cClassTribEntriesForCst(null)).toBe(CCLASSTRIB_TABELA);
    expect(cClassTribEntriesForCst('')).toBe(CCLASSTRIB_TABELA);
  });
});

describe('CST labels are the OFFICIAL names', () => {
  // The seven the old best-effort labels had wrong.
  it.each([
    ['011', 'Tributação com alíquotas uniformes reduzidas'],
    ['220', 'Alíquota fixa'],
    ['221', 'Alíquota fixa proporcional'],
    ['222', 'Redução de Base de Cálculo'],
    ['810', 'Ajuste de IBS na ZFM'],
    ['811', 'Ajustes'],
    ['820', 'Tributação em documento específico'],
  ])('%s → %s', (cst, label) => {
    expect(CST_IBSCBS_LABELS[cst]).toBe(label);
  });
});

describe('table integrity (hand-transcribed data)', () => {
  const INDS_CST = new Set<string>(Object.values(IND_CST_IBSCBS));
  const INDS_ROW = new Set<string>(Object.values(IND_CCLASSTRIB));
  const TIPOS = new Set<number>(Object.values(TIPO_ALIQUOTA_RTC));

  it('the row count is the one the provenance records', () => {
    expect(CCLASSTRIB_TABELA).toHaveLength(CCLASSTRIB_PROVENIENCIA.linhas);
  });

  it('codes are 6 digits, strictly ascending (so unique), each under a known CST', () => {
    for (let i = 0; i < CCLASSTRIB_TABELA.length; i++) {
      const e = CCLASSTRIB_TABELA[i]!;
      expect(e.cClassTrib, e.cClassTrib).toMatch(/^\d{6}$/);
      expect(e.cClassTrib.slice(0, 3)).toBe(e.cst);
      expect(CST_IBSCBS_CODES).toContain(e.cst);
      if (i > 0) expect(e.cClassTrib > CCLASSTRIB_TABELA[i - 1]!.cClassTrib).toBe(true);
    }
  });

  it('descriptions are non-empty and whitespace-folded', () => {
    for (const e of [...CCLASSTRIB_TABELA, ...CST_IBSCBS_TABELA]) {
      expect(e.descricao.length).toBeGreaterThan(0);
      expect(e.descricao).toBe(e.descricao.trim());
      expect(e.descricao).not.toMatch(/\s{2,}|[\r\n\t]/);
    }
  });

  it('every indicator, rate type, percentage and date is a known value', () => {
    for (const e of CCLASSTRIB_TABELA) {
      for (const ind of e.ind) expect(INDS_ROW.has(ind), `${e.cClassTrib} ${ind}`).toBe(true);
      expect(new Set(e.ind).size).toBe(e.ind.length);
      expect(TIPOS.has(e.tipoAliquota)).toBe(true);
      for (const p of [e.pRedIBS, e.pRedCBS]) expect(p >= 0 && p <= 100).toBe(true);
      expect(e.inicioVigencia).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const e of CST_IBSCBS_TABELA) {
      for (const ind of e.ind) expect(INDS_CST.has(ind), `${e.cst} ${ind}`).toBe(true);
    }
  });

  it('the CSTs with NO NF-e row are exactly the ones the snapshot says', () => {
    // Pinned both ways: a refresh that adds an NF-e row to one of these, or
    // drops the last one from another CST, must show up here.
    const semLinha = CST_IBSCBS_CODES.filter((cst) => cClassTribCodesForCst(cst).length === 0);
    expect(semLinha).toEqual(['010', '011', '220', '221', '222', '400', '820']);
  });

  // The indicators the nota de crédito/débito work (#330) builds on.
  it.each([
    ['800', IND_CST_IBSCBS.transferenciaCredito],
    ['810', IND_CST_IBSCBS.credPresIbsZfm],
    ['811', IND_CST_IBSCBS.ajusteCompetencia],
    ['000', IND_CST_IBSCBS.exigeTributacao],
  ] as const)('CST %s carries %s', (cst, ind) => {
    expect(cstIbsCbsEntry(cst)?.ind).toContain(ind);
  });

  it('CST 410 (imunidade) does not require the IBS/CBS group', () => {
    expect(cstIbsCbsEntry('410')?.ind).not.toContain(IND_CST_IBSCBS.exigeTributacao);
  });

  it('410030 (perecimento / roubo) carries the estorno de crédito indicator', () => {
    expect(cClassTribEntry('410030')?.ind).toContain(IND_CCLASSTRIB.estornoCred);
  });
});
