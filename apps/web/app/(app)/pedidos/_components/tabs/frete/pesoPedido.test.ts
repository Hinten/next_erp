import { describe, expect, it } from 'vitest';
import { pesoPedido, shouldSeedVolume, volumePadrao, type ProdutoPesoInfo } from './pesoPedido';

function peso(over: Partial<ProdutoPesoInfo> = {}): ProdutoPesoInfo {
  return { pesoBrutoKg: null, pesoLiquidoKg: null, paiId: null, ...over };
}

describe('pesoPedido', () => {
  it('empty pedido → weight 1 (1kg floor)', () => {
    expect(pesoPedido([], {})).toBe(1);
  });

  it('single item, produto pesoBrutoKg 2.5, qty 3 → 7.5', () => {
    const result = pesoPedido([{ produtoUid: 'p1', quantidade: 3 }], {
      p1: peso({ pesoBrutoKg: 2.5 }),
    });
    expect(result).toBe(7.5);
  });

  it('item whose produto has both weights null but paiId → uses parent bruto', () => {
    const result = pesoPedido([{ produtoUid: 'child', quantidade: 2 }], {
      child: peso({ paiId: 'parent' }),
      parent: peso({ pesoBrutoKg: 4 }),
    });
    expect(result).toBe(8);
  });

  it('variation→parent falls back to parent pesoLiquidoKg when parent has no bruto', () => {
    const result = pesoPedido([{ produtoUid: 'child', quantidade: 1 }], {
      child: peso({ paiId: 'parent' }),
      parent: peso({ pesoLiquidoKg: 1.2 }),
    });
    expect(result).toBe(1.2);
  });

  it('variation→parent falls back to 1 when the parent is unresolvable', () => {
    const result = pesoPedido([{ produtoUid: 'child', quantidade: 2 }], {
      child: peso({ paiId: 'parent' }),
      // parent absent from the map
    });
    expect(result).toBe(2);
  });

  it('item with produto missing entirely contributes 1 * quantidade', () => {
    const result = pesoPedido([{ produtoUid: 'ghost', quantidade: 4 }], {});
    expect(result).toBe(4);
  });

  it('item with no produtoUid and null quantidade contributes 1', () => {
    const result = pesoPedido([{ produtoUid: null, quantidade: null }], {});
    expect(result).toBe(1);
  });

  it('item with no produtoUid but a quantidade contributes 1 * quantidade', () => {
    const result = pesoPedido([{ produtoUid: null, quantidade: 5 }], {});
    expect(result).toBe(5);
  });

  it('a quantidade <= 0 coerces to 1', () => {
    const withProduto = pesoPedido([{ produtoUid: 'p1', quantidade: 0 }], {
      p1: peso({ pesoBrutoKg: 2 }),
    });
    expect(withProduto).toBe(2);

    const withoutProduto = pesoPedido([{ produtoUid: null, quantidade: -3 }], {});
    expect(withoutProduto).toBe(1);
  });

  it('bruto is preferred over líquido when both are present', () => {
    const result = pesoPedido([{ produtoUid: 'p1', quantidade: 1 }], {
      p1: peso({ pesoBrutoKg: 3, pesoLiquidoKg: 9 }),
    });
    expect(result).toBe(3);
  });

  it('falls back to pesoLiquidoKg when bruto is absent', () => {
    const result = pesoPedido([{ produtoUid: 'p1', quantidade: 1 }], {
      p1: peso({ pesoLiquidoKg: 1.8 }),
    });
    expect(result).toBe(1.8);
  });

  it('a produto with both weights absent (no paiId) contributes 1 * quantidade', () => {
    const result = pesoPedido([{ produtoUid: 'p1', quantidade: 3 }], { p1: peso() });
    expect(result).toBe(3);
  });

  it('sums across multiple items, unrounded', () => {
    const result = pesoPedido(
      [
        { produtoUid: 'p1', quantidade: 2 },
        { produtoUid: null, quantidade: 1 },
      ],
      { p1: peso({ pesoBrutoKg: 1.111 }) },
    );
    expect(result).toBeCloseTo(3.222, 10);
  });

  it('a total that computes to <= 0 floors to 1', () => {
    // Not reachable through the coercions above with well-formed input, but
    // the final guard must still hold defensively.
    const result = pesoPedido([{ produtoUid: 'p1', quantidade: 1 }], {
      p1: peso({ pesoBrutoKg: 0, pesoLiquidoKg: 0 }),
    });
    // No paiId → pesoProduto falls back to the `?? 1` in the weight chain, not
    // the paiId branch — still exercises "everything resolves to the 1kg floor".
    expect(result).toBe(1);
  });
});

describe('volumePadrao', () => {
  it('Volume.padrao(4) matches the legacy factory', () => {
    expect(volumePadrao(4)).toEqual({
      quantidade: 1,
      especie: 'Pacote',
      marca: null,
      numero: null,
      pesoBruto: 4,
      pesoLiquido: 3.6,
      dimensoes: { altura: 10, largura: 10, comprimento: 10 },
      lacres: null,
    });
  });

  it('defaults pesoBruto to 1 (0.9 líquido) when called with no argument', () => {
    const v = volumePadrao();
    expect(v.pesoBruto).toBe(1);
    expect(v.pesoLiquido).toBe(0.9);
  });
});

describe('shouldSeedVolume', () => {
  it('does not seed when frete is not active', () => {
    expect(shouldSeedVolume({ temFrete: false, volumes: null, produtoPesoById: {} })).toBe(false);
  });

  it('does not seed when volumes already has entries', () => {
    expect(
      shouldSeedVolume({
        temFrete: true,
        volumes: [volumePadrao()],
        produtoPesoById: {},
      }),
    ).toBe(false);
  });

  it('does not seed while the produto weight batch is still loading', () => {
    expect(shouldSeedVolume({ temFrete: true, volumes: null, produtoPesoById: undefined })).toBe(
      false,
    );
  });

  it('seeds when frete is active, volumes is empty and weights resolved', () => {
    expect(shouldSeedVolume({ temFrete: true, volumes: null, produtoPesoById: {} })).toBe(true);
    expect(shouldSeedVolume({ temFrete: true, volumes: [], produtoPesoById: {} })).toBe(true);
  });
});
