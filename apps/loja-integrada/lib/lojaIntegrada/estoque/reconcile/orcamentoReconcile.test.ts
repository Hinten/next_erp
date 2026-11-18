/**
 * The reconcile slice's time budget (master plan step 12, PR 12-g): the import's rule over the
 * reconcile's own unit table, and the boundary a unit is refused at. Pure.
 */
import { describe, expect, it } from 'vitest';
import { ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS } from '@delfrance/schemas';

import {
  DURACAO_MAXIMA_DESPACHO_IMPORTACAO_LI_MS,
  PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS,
  cabeNoOrcamentoLi,
  cabeNoOrcamentoMsLi,
} from '../../importacao/orcamento';
import {
  DURACAO_MAXIMA_SLICE_RECONCILE_LI_MS,
  PIOR_CASO_UNIDADE_RECONCILE_LI_MS,
  UNIDADE_RECONCILE_LI,
  type UnidadeReconcileLi,
  abrirOrcamentoReconcileLi,
} from './orcamentoReconcile';

describe('the reconcile’s budget is the import’s', () => {
  it('a slice is held to the import’s ceiling — the SAME constant, 100 s', () => {
    expect(DURACAO_MAXIMA_SLICE_RECONCILE_LI_MS).toBe(DURACAO_MAXIMA_DESPACHO_IMPORTACAO_LI_MS);
    expect(DURACAO_MAXIMA_SLICE_RECONCILE_LI_MS).toBe(100_000);
  });

  it('the table has a row for every unit, and no other; each fits an EMPTY budget', () => {
    expect(Object.keys(PIOR_CASO_UNIDADE_RECONCILE_LI_MS).sort()).toEqual(
      Object.values(UNIDADE_RECONCILE_LI).sort(),
    );
    for (const pior of Object.values(PIOR_CASO_UNIDADE_RECONCILE_LI_MS)) {
      expect(pior).toBeLessThanOrEqual(ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS);
    }
  });

  it('⚠️ NEAR-MISS: an erp unit (20 s) starts at 50 000 ms elapsed, and not at 50 001', () => {
    expect(abrirOrcamentoReconcileLi(() => 50_000, 0).cabe('erp')).toBe(true);
    expect(abrirOrcamentoReconcileLi(() => 50_001, 0).cabe('erp')).toBe(false);
    expect(abrirOrcamentoReconcileLi(() => 50_001, 0).cabe('mapa')).toBe(false);
  });

  it('a store call is the import’s own row (the SAME constant, 22 s): it starts at 48 000 ms, not at 48 001', () => {
    expect(PIOR_CASO_UNIDADE_RECONCILE_LI_MS.chamada).toBe(
      PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS.chamada,
    );
    expect(PIOR_CASO_UNIDADE_RECONCILE_LI_MS.chamada).toBe(22_000);
    expect(abrirOrcamentoReconcileLi(() => 48_000, 0).cabe('chamada')).toBe(true);
    expect(abrirOrcamentoReconcileLi(() => 48_001, 0).cabe('chamada')).toBe(false);
  });

  it('⚠️ NEAR-MISS: a page’s lookups (20 s) start at 50 000 ms, and not at 50 001', () => {
    expect(abrirOrcamentoReconcileLi(() => 50_000, 0).cabe('consulta')).toBe(true);
    expect(abrirOrcamentoReconcileLi(() => 50_001, 0).cabe('consulta')).toBe(false);
  });

  it('reads the clock on every question; a clock behind the start is 0 elapsed; a broken clock fits nothing', () => {
    let agora = 0;
    const orcamento = abrirOrcamentoReconcileLi(() => agora, 1_000);
    expect(orcamento.cabe('erp')).toBe(true);
    agora = 71_000;
    expect(orcamento.cabe('erp')).toBe(false);
    expect(abrirOrcamentoReconcileLi(() => Number.NaN, 0).cabe('erp')).toBe(false);
  });

  it('refuses a unit with no row (an untyped caller)', () => {
    expect(() => abrirOrcamentoReconcileLi(() => 0, 0).cabe('foto' as UnidadeReconcileLi)).toThrow(
      TypeError,
    );
  });
});

describe('cabeNoOrcamentoMsLi — the ONE spelling of the rule, which the import delegates to', () => {
  it('⚠️ NEAR-MISS: ends exactly at 70 s ⇒ starts; one ms later ⇒ not', () => {
    expect(cabeNoOrcamentoMsLi(48_000, 22_000)).toBe(true);
    expect(cabeNoOrcamentoMsLi(48_001, 22_000)).toBe(false);
    // The import reads the same answer through its own table.
    expect(cabeNoOrcamentoLi(48_000, 'chamada')).toBe(cabeNoOrcamentoMsLi(48_000, 22_000));
    expect(cabeNoOrcamentoLi(48_001, 'chamada')).toBe(cabeNoOrcamentoMsLi(48_001, 22_000));
  });

  it('a negative elapsed time reads as 0; a non-finite one fits nothing; a bad worst case is a table bug', () => {
    expect(cabeNoOrcamentoMsLi(-5, 70_000)).toBe(true);
    expect(cabeNoOrcamentoMsLi(Number.POSITIVE_INFINITY, 0)).toBe(false);
    expect(() => cabeNoOrcamentoMsLi(0, -1)).toThrow(RangeError);
    expect(() => cabeNoOrcamentoMsLi(0, Number.NaN)).toThrow(RangeError);
  });
});
