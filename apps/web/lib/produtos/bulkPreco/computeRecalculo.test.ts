import { describe, expect, it } from 'vitest';
import type { ListaDePrecos } from '@delfrance/schemas';

import { computeRecalculoRow, listaTemAlgumaFormula } from './computeRecalculo';
import type { KitResolucao, ProdutoPrecoRow } from './loadCatalogo';

function baseRow(overrides: Partial<ProdutoPrecoRow> = {}): ProdutoPrecoRow {
  return {
    id: 'p1',
    sku: 'SKU1',
    nome: 'Produto 1',
    custo: 50,
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

const listaIdentidade: Pick<ListaDePrecos, 'formulasCalculoPreco' | 'formulasPorCategoria'> = {
  formulasCalculoPreco: [
    {
      limiar: 1000,
      formula: 'C',
      taxaFixa: 0,
      custoFixo: 0,
      margemDeLucro: 0,
      comissaoMarketplace: 0,
      imposto: 0,
      frete: 0,
      marketing: 0,
    },
  ],
  formulasPorCategoria: null,
};

const listaSemFormulaAplicavel: Pick<
  ListaDePrecos,
  'formulasCalculoPreco' | 'formulasPorCategoria'
> = {
  formulasCalculoPreco: [
    {
      limiar: 1,
      formula: 'C',
      taxaFixa: 0,
      custoFixo: 0,
      margemDeLucro: 0,
      comissaoMarketplace: 0,
      imposto: 0,
      frete: 0,
      marketing: 0,
    },
  ],
  formulasPorCategoria: null,
};

const listaVazia: Pick<ListaDePrecos, 'formulasCalculoPreco' | 'formulasPorCategoria'> = {
  formulasCalculoPreco: null,
  formulasPorCategoria: null,
};

describe('listaTemAlgumaFormula', () => {
  it('is true when the default bucket has a formula', () => {
    expect(listaTemAlgumaFormula(listaIdentidade)).toBe(true);
  });

  it('is true when only a categoria bucket has a formula', () => {
    expect(
      listaTemAlgumaFormula({
        formulasCalculoPreco: null,
        formulasPorCategoria: {
          cat1: {
            name: 'Cat 1',
            formulasCalculoPreco: [listaIdentidade.formulasCalculoPreco![0]!],
          },
        },
      }),
    ).toBe(true);
  });

  it('is false when both the default bucket and every categoria bucket are empty', () => {
    expect(
      listaTemAlgumaFormula({
        formulasCalculoPreco: [],
        formulasPorCategoria: { cat1: { name: 'Cat 1', formulasCalculoPreco: [] } },
      }),
    ).toBe(false);
    expect(listaTemAlgumaFormula(listaVazia)).toBe(false);
  });
});

describe('computeRecalculoRow', () => {
  it('errors "Produto sem custo" (with the sku) when the produto has no custo', () => {
    const row = baseRow({ custo: null, sku: 'ABC' });
    const out = computeRecalculoRow(row, emptyResolucao(), 'lista1', listaIdentidade);
    expect(out.erro).toBe('Produto sem custo ABC - Produto 1');
    expect(out.precoNovo).toBeNull();
    expect(out.custo).toBeNull();
  });

  it('falls back to "Sem Sku" in the error string when sku is null', () => {
    const row = baseRow({ custo: null, sku: null });
    const out = computeRecalculoRow(row, emptyResolucao(), 'lista1', listaIdentidade);
    expect(out.erro).toBe('Produto sem custo Sem Sku - Produto 1');
  });

  it('errors "Produto sem custo" when a kit component cost cannot be resolved (kit faltando)', () => {
    const row = baseRow({
      custo: null,
      ehKit: true,
      componentesKit: { comp1: { quantidade: 1, limitarEstoque: true, timestamp: null } },
    });
    // comp1 absent from every KitResolucao map → custoDoKit reports it missing.
    const out = computeRecalculoRow(row, emptyResolucao(), 'lista1', listaIdentidade);
    expect(out.erro).toBe('Produto sem custo SKU1 - Produto 1');
  });

  it('errors "Produto com custo no valor de X" when the effective custo is <= 0', () => {
    const row = baseRow({ custo: 0 });
    const out = computeRecalculoRow(row, emptyResolucao(), 'lista1', listaIdentidade);
    expect(out.erro).toBe('Produto com custo no valor de 0 - SKU1 - Produto 1');
    expect(out.custo).toBe(0);
    expect(out.precoNovo).toBeNull();
  });

  it('errors "Preço nulo para o produto" when no formula produces a usable price', () => {
    const row = baseRow({ custo: 100 });
    const out = computeRecalculoRow(row, emptyResolucao(), 'lista1', listaSemFormulaAplicavel);
    expect(out.erro).toBe('Preço nulo para o produto SKU1 - Produto 1');
    expect(out.custo).toBe(100);
    expect(out.precoNovo).toBeNull();
  });

  it('computes precoNovo and precoAtual (from the target lista key) on success, with erro null', () => {
    const row = baseRow({ custo: 50, precos: { lista1: { valor: 40 }, lista2: { valor: 999 } } });
    const out = computeRecalculoRow(row, emptyResolucao(), 'lista1', listaIdentidade);
    expect(out.erro).toBeNull();
    expect(out.precoNovo).toBe(50);
    expect(out.precoAtual).toBe(40);
    expect(out.custo).toBe(50);
    expect(out.precos).toEqual({ lista1: { valor: 40 }, lista2: { valor: 999 } });
  });

  it('precoAtual is null when the produto has no price yet under the target lista', () => {
    const row = baseRow({ custo: 50, precos: { outraLista: { valor: 40 } } });
    const out = computeRecalculoRow(row, emptyResolucao(), 'lista1', listaIdentidade);
    expect(out.precoAtual).toBeNull();
  });
});
