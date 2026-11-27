/**
 * `orcamentoPrecoReconcile.ts` (master plan step 13, PR 13-f1): the price units' worst cases and
 * the shared rule — a unit starts only while its worst case still ends inside the slice's 70 s.
 */
import { describe, expect, it } from 'vitest';

import {
  PIOR_CASO_UNIDADE_PRECO_RECONCILE_LI_MS,
  UNIDADE_PRECO_RECONCILE_LI,
  abrirOrcamentoPrecoReconcileLi,
} from './orcamentoPrecoReconcile';
import { PIOR_CASO_UNIDADE_RECONCILE_LI_MS } from './orcamentoReconcile';

describe('the price units’ budget', () => {
  it('the rows, pinned: the end PAIR is the stock end plus the price end', () => {
    expect(PIOR_CASO_UNIDADE_PRECO_RECONCILE_LI_MS).toEqual({
      paisPreco: 20_000,
      fimPreco: 20_000,
      fimComPreco: 40_000,
    });
    expect(PIOR_CASO_UNIDADE_PRECO_RECONCILE_LI_MS.fimComPreco).toBe(
      PIOR_CASO_UNIDADE_RECONCILE_LI_MS.fim + PIOR_CASO_UNIDADE_PRECO_RECONCILE_LI_MS.fimPreco,
    );
  });

  it('a unit fits only while elapsed + its worst case ≤ 70 s — exactly at the edge it fits', () => {
    const agora = { ms: 0 };
    const o = abrirOrcamentoPrecoReconcileLi(() => agora.ms, 0);
    agora.ms = 30_000;
    expect(o.cabe(UNIDADE_PRECO_RECONCILE_LI.fimComPreco)).toBe(true);
    agora.ms = 30_001;
    expect(o.cabe(UNIDADE_PRECO_RECONCILE_LI.fimComPreco)).toBe(false);
    expect(o.cabe(UNIDADE_PRECO_RECONCILE_LI.paisPreco)).toBe(true);
    agora.ms = 50_001;
    expect(o.cabe(UNIDADE_PRECO_RECONCILE_LI.paisPreco)).toBe(false);
  });

  it('a unit with no row is a TypeError (only an untyped caller can pass one)', () => {
    const o = abrirOrcamentoPrecoReconcileLi(() => 0, 0);
    expect(() => o.cabe('outra' as never)).toThrow(TypeError);
  });
});
