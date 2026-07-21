import { describe, expect, it } from 'vitest';

import { custoEfetivo, pesoEfetivoKg } from './efetivos';
import type { KitResolucao, ProdutoPrecoRow } from './loadCatalogo';

function baseRow(overrides: Partial<ProdutoPrecoRow> = {}): ProdutoPrecoRow {
  return {
    id: 'p1',
    sku: null,
    nome: 'Produto',
    custo: null,
    precos: null,
    categoriaId: null,
    pesoBrutoKg: null,
    pesoLiquidoKg: null,
    ehKit: false,
    componentesKit: null,
    ...overrides,
  };
}

function emptyResolucao(overrides: Partial<KitResolucao> = {}): KitResolucao {
  return {
    custoByProdutoId: {},
    pesoBrutoByProdutoId: {},
    pesoLiquidoByProdutoId: {},
    paiByProdutoId: {},
    ...overrides,
  };
}

describe('custoEfetivo', () => {
  it('non-kit: returns the produto own custo untouched, never faltando', () => {
    expect(custoEfetivo(baseRow({ custo: 42 }), emptyResolucao())).toEqual({
      custo: 42,
      faltando: [],
    });
  });

  it('non-kit: a null custo passes through as null (caller reports the error upstream)', () => {
    expect(custoEfetivo(baseRow({ custo: null }), emptyResolucao())).toEqual({
      custo: null,
      faltando: [],
    });
  });

  it('kit: sums resolvable component costs via custoDoKit', () => {
    const row = baseRow({
      ehKit: true,
      componentesKit: { c1: { quantidade: 2, limitarEstoque: true, timestamp: null } },
    });
    const r = emptyResolucao({ custoByProdutoId: { c1: 10 } });
    expect(custoEfetivo(row, r)).toEqual({ custo: 20, faltando: [] });
  });

  it('kit: reports an unresolvable component in faltando, custo stays null', () => {
    const row = baseRow({
      ehKit: true,
      componentesKit: { c1: { quantidade: 1, limitarEstoque: true, timestamp: null } },
    });
    expect(custoEfetivo(row, emptyResolucao())).toEqual({ custo: null, faltando: ['c1'] });
  });

  it('kit: a component with no own cost resolves through its paiId fallback', () => {
    const row = baseRow({
      ehKit: true,
      componentesKit: { c1: { quantidade: 1, limitarEstoque: true, timestamp: null } },
    });
    const r = emptyResolucao({
      custoByProdutoId: { c1: null, parentOfC1: 30 },
      paiByProdutoId: { c1: 'parentOfC1' },
    });
    expect(custoEfetivo(row, r)).toEqual({ custo: 30, faltando: [] });
  });
});

describe('pesoEfetivoKg', () => {
  it('non-kit: prefers pesoBrutoKg over pesoLiquidoKg', () => {
    expect(pesoEfetivoKg(baseRow({ pesoBrutoKg: 3, pesoLiquidoKg: 2 }), emptyResolucao())).toBe(3);
  });

  it('non-kit: falls back to pesoLiquidoKg when bruto is absent', () => {
    expect(pesoEfetivoKg(baseRow({ pesoBrutoKg: null, pesoLiquidoKg: 2 }), emptyResolucao())).toBe(
      2,
    );
  });

  it('non-kit: falls back to the crude 0.25kg default when both are absent', () => {
    expect(
      pesoEfetivoKg(baseRow({ pesoBrutoKg: null, pesoLiquidoKg: null }), emptyResolucao()),
    ).toBe(0.25);
  });

  it('kit: sums resolvable component bruto weights (kit-bruto branch wins over líquido)', () => {
    const row = baseRow({
      ehKit: true,
      componentesKit: { c1: { quantidade: 2, limitarEstoque: true, timestamp: null } },
    });
    const r = emptyResolucao({
      pesoBrutoByProdutoId: { c1: 1.5 },
      pesoLiquidoByProdutoId: { c1: 999 }, // must be ignored — bruto resolved
    });
    expect(pesoEfetivoKg(row, r)).toBe(3);
  });

  it('kit: falls back to the per-component KIT_PESO_BRUTO_FALLBACK_KG when no component bruto weight resolves', () => {
    const row = baseRow({
      ehKit: true,
      componentesKit: { c1: { quantidade: 2, limitarEstoque: true, timestamp: null } },
    });
    // pesoDoKit never reports "missing" for a non-empty componentesKit — every
    // unresolved component weight uses the 0.3kg bruto fallback internally, so
    // this still resolves via the bruto branch (0.3 * 2 = 0.6), never reaching
    // the líquido branch or the outer 0.25 default.
    expect(pesoEfetivoKg(row, emptyResolucao())).toBe(0.6);
  });

  it('kit: an empty componentesKit falls all the way through to the crude 0.25kg default', () => {
    // pesoDoKit returns null (not a fallback value) only for an empty/absent
    // componentesKit — that's the one case the outer bruto/líquido/0.25 chain
    // actually exercises for a kit.
    const row = baseRow({ ehKit: true, componentesKit: {} });
    expect(pesoEfetivoKg(row, emptyResolucao())).toBe(0.25);
  });

  it('kit: a null componentesKit behaves the same as empty (0.25kg default)', () => {
    const row = baseRow({ ehKit: true, componentesKit: null });
    expect(pesoEfetivoKg(row, emptyResolucao())).toBe(0.25);
  });
});
