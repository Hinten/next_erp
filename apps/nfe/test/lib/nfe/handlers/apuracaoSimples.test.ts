/**
 * The apuração's decisions, tested where they can be wrong.
 *
 * The aggregate itself is a Pipelines query, which the emulator cannot run —
 * so it is injected, and what is exercised here is the folding, the state
 * machine and the promotion rule.
 */
import { describe, expect, it } from 'vitest';

import {
  dobrarGrupos,
  estadoDaApuracao,
  notasForaDoAgregado,
  notasNaoContabilizadas,
  raizCnpj,
  type GrupoReceita,
  type ReceitaDaJanela,
} from '../../../../lib/nfe/handlers/runApuracaoSimples';
import { interpretarLinhasDoAgregado } from '../../../../lib/nfe/handlers/fetchReceitaSimples';

function grupo(over: Partial<GrupoReceita> = {}): GrupoReceita {
  return { filialId: 'f1', tpNF: 1, finNFe: 1, receita: 1000, notas: 1, ...over };
}

describe('raizCnpj — the company, not the establishment', () => {
  it('takes the first eight digits', () => {
    expect(raizCnpj('12345678000199')).toBe('12345678');
  });

  it('strips punctuation first', () => {
    expect(raizCnpj('12.345.678/0001-99')).toBe('12345678');
  });

  it('matriz and filial of the same company share a root', () => {
    // This is the whole point: they must land in ONE RBT12.
    expect(raizCnpj('12345678000199')).toBe(raizCnpj('12.345.678/0002-70'));
  });

  it('different companies do NOT share a root', () => {
    expect(raizCnpj('12345678000199')).not.toBe(raizCnpj('99999999000199'));
  });

  it.each([['123'], [''], ['abcdefghijklmn'], [null], [undefined]])(
    'refuses %s rather than guessing a root',
    (v) => expect(raizCnpj(v as string | null | undefined)).toBeNull(),
  );
});

describe('dobrarGrupos — the sign comes from the shared rule', () => {
  it('sums a plain sale', () => {
    expect(dobrarGrupos([grupo({ receita: 1000, notas: 3 })])).toEqual({
      receita: 1000,
      notasContadas: 3,
      notasNeutras: 0,
    });
  });

  it('SUBTRACTS a customer return (entrada + devolução)', () => {
    const r = dobrarGrupos([
      grupo({ receita: 1000, notas: 2 }),
      grupo({ tpNF: 0, finNFe: 4, receita: 300, notas: 1 }),
    ]);
    expect(r.receita).toBe(700);
    expect(r.notasContadas).toBe(3);
  });

  it('does NOT subtract a purchase return (saída + devolução)', () => {
    // Same finNFe=4, opposite meaning — the near-miss.
    const r = dobrarGrupos([
      grupo({ receita: 1000, notas: 2 }),
      grupo({ tpNF: 1, finNFe: 4, receita: 300, notas: 1 }),
    ]);
    expect(r.receita).toBe(1000);
    expect(r.notasNeutras).toBe(1);
  });

  it('counts neutral notes separately instead of dropping them silently', () => {
    // An ajuste contributes nothing, but the accountant must be able to see
    // how many were excluded rather than meet the gap in the PGDAS-D.
    const r = dobrarGrupos([grupo({ finNFe: 3, receita: 5000, notas: 4 })]);
    expect(r.receita).toBe(0);
    expect(r.notasNeutras).toBe(4);
    expect(r.notasContadas).toBe(0);
  });

  it('an empty window is zero, not NaN', () => {
    expect(dobrarGrupos([])).toEqual({ receita: 0, notasContadas: 0, notasNeutras: 0 });
  });

  it('returns can exceed sales — a negative RBT12 is representable', () => {
    const r = dobrarGrupos([grupo({ tpNF: 0, finNFe: 4, receita: 500, notas: 1 })]);
    expect(r.receita).toBe(-500);
  });
});

// ── The promotion rule — the safety property of the whole feature ─────────
describe('estadoDaApuracao', () => {
  it('promotes when the window was read in full and recalculation is authorised', () => {
    expect(
      estadoDaApuracao({ notasIlegiveis: 0, recalculoAutomatico: true, aliquotaOk: true }),
    ).toBe('vigente');
  });

  it('withholds when recalculation is not authorised', () => {
    expect(
      estadoDaApuracao({ notasIlegiveis: 0, recalculoAutomatico: false, aliquotaOk: true }),
    ).toBe('aguardandoAutorizacao');
  });

  it('⚠️ an unreadable note BLOCKS promotion even when authorised', () => {
    // The load-bearing case. Firestore's `sum()` skips a document missing the
    // field in silence, so an unreadable note would quietly shrink RBT12, pull
    // the company into a lower faixa and under-declare the tax — with the job
    // still reporting success. A half-read window is not a small RBT12; it is
    // one nobody knows.
    expect(
      estadoDaApuracao({ notasIlegiveis: 1, recalculoAutomatico: true, aliquotaOk: true }),
    ).toBe('incompleta');
  });

  it('ilegíveis outrank authorisation in BOTH directions', () => {
    expect(
      estadoDaApuracao({ notasIlegiveis: 7, recalculoAutomatico: false, aliquotaOk: true }),
    ).toBe('incompleta');
  });

  it('an RBT12 outside the regime never promotes, whatever the flags', () => {
    expect(
      estadoDaApuracao({ notasIlegiveis: 0, recalculoAutomatico: true, aliquotaOk: false }),
    ).toBe('foraDoRegime');
  });
});

// ── Reading the aggregate back ────────────────────────────────────────────
describe('interpretarLinhasDoAgregado', () => {
  it('builds a group per (filial, tpNF, finNFe) from the server-side sum', () => {
    const r = interpretarLinhasDoAgregado([
      { filialId: 'f1', tpNF: 1, finNFe: 1, receita: 950, nNotas: 3, nIlegiveis: 0 },
    ]);
    expect(r.grupos).toEqual([{ filialId: 'f1', tpNF: 1, finNFe: 1, receita: 950, notas: 3 }]);
    expect(r.notasIlegiveis).toBe(0);
  });

  it('⚠️ counts unreadable notes from a row it DISCARDS as a group', () => {
    // A note without `totais` has no tpNF/finNFe either, so it lands in a
    // null-key group that is revenue for nobody. Counting nIlegiveis only from
    // valid rows would lose exactly the notes the counter exists to surface.
    const r = interpretarLinhasDoAgregado([
      { filialId: 'f1', tpNF: 1, finNFe: 1, receita: 100, nNotas: 1, nIlegiveis: 0 },
      { filialId: 'f1', tpNF: null, finNFe: null, nNotas: 0, nIlegiveis: 5 },
    ]);
    expect(r.grupos).toHaveLength(1);
    expect(r.notasIlegiveis).toBe(5);
  });

  it('⚠️ a row with no filialId is NOT invented into a group — and NOT dropped either', () => {
    // The #1546 review finding. `filialId` is `.nullable().optional()` for
    // read-tolerance of the legacy corpus, so an approved note carrying revenue
    // and no filial is a shape the first real apuração will meet. It used to be
    // dropped by the `where` and counted nowhere: RBT12 quietly short, faixa
    // lower, tax under-declared, `notasIlegiveis === 0`, rate PROMOTED.
    const r = interpretarLinhasDoAgregado([
      { tpNF: 1, finNFe: 1, receita: 100, nNotas: 4, nIlegiveis: 0 },
    ]);
    expect(r.grupos).toHaveLength(0);
    expect(r.notasIndeterminadas).toBe(4);
  });

  it('⚠️ NEAR-MISS: an unattributed NEUTRAL note does not block — it is revenue for nobody', () => {
    // The other direction. A saída+ajuste is not revenue even when its filial
    // IS configured, so counting it would be a false positive that never
    // clears: one legacy adjustment note would freeze every rate for ever.
    const r = interpretarLinhasDoAgregado([
      { tpNF: 1, finNFe: 3, receita: 100, nNotas: 4, nIlegiveis: 0 },
    ]);
    expect(r.grupos).toHaveLength(0);
    expect(r.notasIndeterminadas).toBe(0);
  });

  it('a group whose sum came back absent is zero, not NaN', () => {
    const r = interpretarLinhasDoAgregado([{ filialId: 'f1', tpNF: 1, finNFe: 1, nNotas: 1 }]);
    expect(r.grupos[0]?.receita).toBe(0);
    expect(Number.isNaN(r.grupos[0]?.receita)).toBe(false);
  });

  it('carries a NEGATIVE group sum through — returns exceeding sales are real', () => {
    const r = interpretarLinhasDoAgregado([
      { filialId: 'f1', tpNF: 0, finNFe: 4, receita: -250, nNotas: 2, nIlegiveis: 0 },
    ]);
    expect(r.grupos[0]?.receita).toBe(-250);
  });

  it('rejects an out-of-range tpNF instead of coercing it into a group', () => {
    const r = interpretarLinhasDoAgregado([
      { filialId: 'f1', tpNF: 7, finNFe: 1, receita: 100, nNotas: 3, nIlegiveis: 2 },
    ]);
    expect(r.grupos).toHaveLength(0);
    // …but its unreadable count still surfaces, and its notes are counted as
    // undeterminable: a code the schema does not know could be revenue.
    expect(r.notasIlegiveis).toBe(2);
    expect(r.notasIndeterminadas).toBe(3);
  });
});

// ── The control total ─────────────────────────────────────────────────────
describe('notasForaDoAgregado — what the aggregate could not even see', () => {
  it('reports the shortfall between the control count and what was seen', () => {
    expect(notasForaDoAgregado({ total: 100, vistas: 93 })).toBe(7);
  });

  it('is zero when the aggregate saw everything', () => {
    expect(notasForaDoAgregado({ total: 100, vistas: 100 })).toBe(0);
  });

  it('⚠️ never goes NEGATIVE — a credit of illegible notes would erase a real block', () => {
    // The two aggregates are separate executions; an emission landing between
    // them can leave the aggregate one note ahead of the control. Folding a
    // negative in would cancel a genuine block coming from another source.
    expect(notasForaDoAgregado({ total: 100, vistas: 104 })).toBe(0);
  });
});

// ── Attribution: the notes no RBT12 will receive ──────────────────────────
describe('notasNaoContabilizadas — the three doors revenue used to leave by', () => {
  function janela(over: Partial<ReceitaDaJanela> = {}): ReceitaDaJanela {
    return { grupos: [], notasIlegiveis: 0, notasIndeterminadas: 0, ...over };
  }

  it('is zero when every group belongs to a configured filial and the control agrees', () => {
    const n = notasNaoContabilizadas({
      janela: janela({ grupos: [grupo({ filialId: 'f1', notas: 6 })] }),
      totalNaJanela: 6,
      configuradas: new Set(['f1']),
    });
    expect(n).toBe(0);
  });

  it('⚠️ DOOR 1 — a group whose filial is not configured blocks, it does not vanish', () => {
    // RBT12 is the LEGAL ENTITY's revenue, matriz plus filiais, one DAS. A
    // sibling establishment with no Simples config still emits notes, and its
    // revenue belongs in that sum. It used to be dropped by the `where` and
    // counted nowhere.
    const n = notasNaoContabilizadas({
      janela: janela({
        grupos: [grupo({ filialId: 'f1', notas: 6 }), grupo({ filialId: 'f9', notas: 4 })],
      }),
      totalNaJanela: 10,
      configuradas: new Set(['f1']),
    });
    expect(n).toBe(4);
  });

  it('⚠️ DOOR 2 — notes the aggregate could not attribute at all block', () => {
    const n = notasNaoContabilizadas({
      janela: janela({ grupos: [grupo({ notas: 6 })], notasIndeterminadas: 3 }),
      totalNaJanela: 9,
      configuradas: new Set(['f1']),
    });
    expect(n).toBe(3);
  });

  it('⚠️ DOOR 3 — notes the aggregate never even saw block', () => {
    // The sparse-index case: if a document missing `totais.receitaBruta` is not
    // in the six-field index, the `where` never reaches it and `countIf` counts
    // zero. The control total is read from a two-field index every document is
    // in, so the shortfall surfaces here instead of nowhere.
    const n = notasNaoContabilizadas({
      janela: janela({ grupos: [grupo({ notas: 6 })] }),
      totalNaJanela: 11,
      configuradas: new Set(['f1']),
    });
    expect(n).toBe(5);
  });

  it('⚠️ NEAR-MISS: a NEUTRAL note of an unconfigured filial does NOT block', () => {
    // A saída+ajuste is revenue for nobody, configured or not. Counting it
    // would freeze every rate for ever over a note that can never be resolved,
    // because there is nothing to resolve.
    const n = notasNaoContabilizadas({
      janela: janela({ grupos: [grupo({ filialId: 'f9', finNFe: 3, notas: 4 })] }),
      totalNaJanela: 4,
      configuradas: new Set(['f1']),
    });
    expect(n).toBe(0);
  });

  it('an ilegível note is not double-counted as missing from the control', () => {
    // `notasIlegiveis` already blocks on its own; the control must not add it a
    // second time, or the log would name a number nobody can reconcile.
    const n = notasNaoContabilizadas({
      janela: janela({ grupos: [grupo({ notas: 6 })], notasIlegiveis: 2 }),
      totalNaJanela: 8,
      configuradas: new Set(['f1']),
    });
    expect(n).toBe(0);
  });

  it('the three doors add up rather than masking one another', () => {
    const n = notasNaoContabilizadas({
      janela: janela({
        grupos: [grupo({ filialId: 'f1', notas: 6 }), grupo({ filialId: 'f9', notas: 4 })],
        notasIndeterminadas: 3,
      }),
      totalNaJanela: 20, // 6 + 4 + 3 seen, so 7 never reached the aggregate
      configuradas: new Set(['f1']),
    });
    expect(n).toBe(4 + 3 + 7);
  });
});
