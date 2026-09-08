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
  raizCnpj,
  type GrupoReceita,
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
  it('builds a group per (filial, tpNF, finNFe)', () => {
    const r = interpretarLinhasDoAgregado([
      {
        filialId: 'f1',
        tpNF: 1,
        finNFe: 1,
        vProd: 1000,
        vDesc: 100,
        vFrete: 50,
        vSeg: 0,
        vOutro: 0,
        nNotas: 3,
        nIlegiveis: 0,
      },
    ]);
    expect(r.grupos).toEqual([{ filialId: 'f1', tpNF: 1, finNFe: 1, receita: 950, notas: 3 }]);
    expect(r.notasIlegiveis).toBe(0);
  });

  it('⚠️ counts unreadable notes from a row it DISCARDS as a group', () => {
    // A note without `totais` has no tpNF/finNFe either, so it lands in a
    // null-key group that is revenue for nobody. Counting nIlegiveis only from
    // valid rows would lose exactly the notes the counter exists to surface.
    const r = interpretarLinhasDoAgregado([
      { filialId: 'f1', tpNF: 1, finNFe: 1, vProd: 100, nNotas: 1, nIlegiveis: 0 },
      { filialId: 'f1', tpNF: null, finNFe: null, nNotas: 0, nIlegiveis: 5 },
    ]);
    expect(r.grupos).toHaveLength(1);
    expect(r.notasIlegiveis).toBe(5);
  });

  it('skips a row with no filialId rather than inventing one', () => {
    const r = interpretarLinhasDoAgregado([{ tpNF: 1, finNFe: 1, vProd: 100, nIlegiveis: 0 }]);
    expect(r.grupos).toHaveLength(0);
  });

  it('treats an absent component as zero, not NaN', () => {
    const r = interpretarLinhasDoAgregado([
      { filialId: 'f1', tpNF: 1, finNFe: 1, vProd: 100, nNotas: 1 },
    ]);
    expect(r.grupos[0]?.receita).toBe(100);
    expect(Number.isNaN(r.grupos[0]?.receita)).toBe(false);
  });

  it('rejects an out-of-range tpNF instead of coercing it into a group', () => {
    const r = interpretarLinhasDoAgregado([
      { filialId: 'f1', tpNF: 7, finNFe: 1, vProd: 100, nIlegiveis: 2 },
    ]);
    expect(r.grupos).toHaveLength(0);
    // …but its unreadable count still surfaces.
    expect(r.notasIlegiveis).toBe(2);
  });
});
