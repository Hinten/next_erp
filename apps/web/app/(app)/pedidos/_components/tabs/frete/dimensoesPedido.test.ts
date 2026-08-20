import { describe, expect, it } from 'vitest';
import {
  dimensoesPedido,
  ESPESSURA_MAX_SACO_CM,
  FATOR_OCUPACAO,
  LIMITE_LEGAL_CM,
  LIMITE_SEM_SOBRETAXA_CM,
  LIMITE_SOMA_CM,
} from './dimensoesPedido';
import { DIMENSOES_PADRAO, type ProdutoMedidas } from './pesoPedido';

function medidas(over: Partial<ProdutoMedidas> = {}): ProdutoMedidas {
  return {
    pesoBrutoKg: null,
    pesoLiquidoKg: null,
    alturaCm: null,
    larguraCm: null,
    profundidadeCm: null,
    paiId: null,
    ...over,
  };
}

/** A produto shaped like a box: `alturaCm × larguraCm × profundidadeCm`. */
const caixa = (a: number, l: number, p: number, over: Partial<ProdutoMedidas> = {}) =>
  medidas({ alturaCm: a, larguraCm: l, profundidadeCm: p, ...over });

const volumeDe = (d: { altura: number; largura: number; comprimento: number }) =>
  d.altura * d.largura * d.comprimento;
const somaDe = (d: { altura: number; largura: number; comprimento: number }) =>
  d.altura + d.largura + d.comprimento;

describe('dimensoesPedido — nothing to measure', () => {
  it('no items → the default box, flagged', () => {
    const r = dimensoesPedido([], {});
    expect(r.dimensoes).toEqual(DIMENSOES_PADRAO);
    expect(r.aviso).toBe('semDimensoes');
  });

  it('a produto with no dimensions → the default box, flagged', () => {
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 1 }], { p1: medidas() });
    expect(r.dimensoes).toEqual(DIMENSOES_PADRAO);
    expect(r.aviso).toBe('semDimensoes');
  });

  it('a partial set of dimensions does not count — a box needs all three', () => {
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 1 }], {
      p1: medidas({ alturaCm: 10, larguraCm: 10, profundidadeCm: null }),
    });
    expect(r.aviso).toBe('semDimensoes');
  });

  it('a zero or negative axis does not count either', () => {
    for (const ruim of [0, -5]) {
      const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 1 }], {
        p1: caixa(10, 10, ruim),
      });
      expect(r.aviso).toBe('semDimensoes');
    }
  });

  it('the default box clears the Correios minimum, unlike the legacy 10×10×10', () => {
    // The legacy `Dimensoes.padrao()` used comprimento 10, one centimetre under
    // the 11cm floor for a caixa/pacote.
    expect(DIMENSOES_PADRAO.comprimento).toBe(11);
  });
});

describe('dimensoesPedido — resolution rules', () => {
  it('skips rows with quantidade <= 0 entirely', () => {
    // ⚠️ Differs from `pesoPedido`, which coerces such a quantidade to 1.
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 0 }], { p1: caixa(10, 10, 10) });
    expect(r.aviso).toBe('semDimensoes');
  });

  it('resolves a legacy full-path produtoUid the same as its bare id', () => {
    const um = dimensoesPedido([{ produtoUid: 'produtos/p1', quantidade: 1 }], {
      p1: caixa(10, 10, 10),
    });
    const outro = dimensoesPedido([{ produtoUid: 'p1', quantidade: 1 }], { p1: caixa(10, 10, 10) });
    expect(um.dimensoes).toEqual(outro.dimensoes);
  });

  it('falls back to the parent when the child has no dimensions of its own', () => {
    const r = dimensoesPedido([{ produtoUid: 'filho', quantidade: 1 }], {
      filho: medidas({ paiId: 'pai' }),
      pai: caixa(10, 20, 30),
    });
    expect(r.aviso).not.toBe('semDimensoes');
    expect(volumeDe(r.dimensoes)).toBeGreaterThanOrEqual(6000);
  });

  it("PREFERS the child's own box over the parent's", () => {
    // ⚠️ The legacy takes the parent unconditionally whenever `paiId` is set
    // (`models.dart:2797`), throwing away a variation's real box. We do not.
    const r = dimensoesPedido([{ produtoUid: 'filho', quantidade: 1 }], {
      filho: caixa(2, 2, 2, { paiId: 'pai' }),
      pai: caixa(50, 50, 50),
    });
    // The parent's 50cm box would have forced 50cm floors; the child's 2cm one
    // does not.
    expect(r.dimensoes.altura).toBeLessThan(50);
  });

  it('an unresolvable parent leaves the item uncounted', () => {
    const r = dimensoesPedido([{ produtoUid: 'filho', quantidade: 1 }], {
      filho: medidas({ paiId: 'pai' }),
    });
    expect(r.aviso).toBe('semDimensoes');
  });
});

describe('dimensoesPedido — bag selection', () => {
  it('a small flat item goes in the smallest bag that fits it', () => {
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 1 }], { p1: caixa(1, 10, 15) });
    expect(r.embalagem).toBe('saco');
    // A 10×15 footprint fits the smallest stocked bag, so nothing bigger is used.
    expect(r.dimensoes.largura).toBe(12);
    expect(r.dimensoes.comprimento).toBe(18);
    expect(r.aviso).toBeNull();
  });

  it('grows to the next bag when the item does not fit the footprint', () => {
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 1 }], { p1: caixa(1, 22, 28) });
    expect(r.embalagem).toBe('saco');
    // The item's two largest sides are 28 and 22. 12×18 and 19×25 are out on
    // both counts, and 20×30 fits the 28 but not the 22 — the SHORT side of the
    // bag is what rules it out. 26×36 is the first that holds it.
    expect(r.dimensoes.largura).toBe(26);
    expect(r.dimensoes.comprimento).toBe(36);
  });

  it('the bag is never thinner than the chunkiest single item', () => {
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 1 }], { p1: caixa(5, 10, 15) });
    expect(r.embalagem).toBe('saco');
    expect(r.dimensoes.altura).toBeGreaterThanOrEqual(5);
  });

  it('falls through to a box once the pack would be too thick for any bag', () => {
    // Volume needs ~10cm of thickness even in the largest bag → past the limit.
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 40 }], { p1: caixa(10, 20, 30) });
    expect(r.embalagem).toBe('caixa');
  });

  it('a bulky single item never goes in a bag', () => {
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 1 }], { p1: caixa(30, 30, 30) });
    expect(r.embalagem).toBe('caixa');
  });

  it('the thickness limit is the documented constant', () => {
    expect(ESPESSURA_MAX_SACO_CM).toBe(8);
  });
});

describe('dimensoesPedido — box sizing', () => {
  it('holds the packed volume, not just the raw item volume', () => {
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 10 }], { p1: caixa(20, 20, 20) });
    const exigido = (20 * 20 * 20 * 10) / FATOR_OCUPACAO;
    expect(volumeDe(r.dimensoes)).toBeGreaterThanOrEqual(exigido);
  });

  it('is never smaller than the largest single item on any axis', () => {
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 1 }], { p1: caixa(40, 12, 55) });
    expect(r.dimensoes.altura).toBeGreaterThanOrEqual(40);
    expect(r.dimensoes.largura).toBeGreaterThanOrEqual(12);
    expect(r.dimensoes.comprimento).toBeGreaterThanOrEqual(55);
  });

  it('stays under 60cm on every side while it can, and says nothing', () => {
    // 150 units still fit inside the 60cm envelope — just.
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 150 }], { p1: caixa(10, 10, 10) });
    expect(r.aviso).toBeNull();
    for (const v of Object.values(r.dimensoes)) expect(v).toBeLessThanOrEqual(60);
  });

  it('grows cube-like rather than filling one axis first', () => {
    // The legacy fills altura to its cap before touching largura, which drives
    // one side over the 60cm surcharge line as fast as possible. Growing the
    // smallest axis keeps the LARGEST side as small as the volume allows.
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 60 }], { p1: caixa(10, 10, 10) });
    const lados = [r.dimensoes.altura, r.dimensoes.largura, r.dimensoes.comprimento];
    expect(Math.max(...lados) - Math.min(...lados)).toBeLessThanOrEqual(10);
  });

  it('warns when the volume forces a side past 60cm', () => {
    // 60³ = 216.000cm³ is the largest surcharge-free box, so 160 units of a
    // 1.000cm³ item (228.571cm³ once packed) is the first that must break it.
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 160 }], { p1: caixa(10, 10, 10) });
    expect(r.aviso).toBe('excedeu60');
    expect(
      Math.max(r.dimensoes.altura, r.dimensoes.largura, r.dimensoes.comprimento),
    ).toBeGreaterThan(LIMITE_SEM_SOBRETAXA_CM);
  });

  it('never exceeds the Correios ceilings, even when it cannot fit', () => {
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 5000 }], { p1: caixa(20, 20, 20) });
    expect(r.aviso).toBe('excedeuLimiteLegal');
    for (const v of Object.values(r.dimensoes)) expect(v).toBeLessThanOrEqual(LIMITE_LEGAL_CM);
    expect(somaDe(r.dimensoes)).toBeLessThanOrEqual(LIMITE_SOMA_CM);
  });

  it('an item bigger than the legal limit still yields a clamped, legal box', () => {
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 1 }], { p1: caixa(150, 150, 150) });
    expect(r.aviso).toBe('excedeuLimiteLegal');
    for (const v of Object.values(r.dimensoes)) expect(v).toBeLessThanOrEqual(LIMITE_LEGAL_CM);
    expect(somaDe(r.dimensoes)).toBeLessThanOrEqual(LIMITE_SOMA_CM);
  });

  it('reports whole centimetres', () => {
    const r = dimensoesPedido([{ produtoUid: 'p1', quantidade: 7 }], { p1: caixa(11, 13, 17) });
    for (const v of Object.values(r.dimensoes)) expect(Number.isInteger(v)).toBe(true);
  });

  it('sums several different produtos', () => {
    const um = dimensoesPedido([{ produtoUid: 'p1', quantidade: 1 }], { p1: caixa(20, 20, 20) });
    const dois = dimensoesPedido(
      [
        { produtoUid: 'p1', quantidade: 1 },
        { produtoUid: 'p2', quantidade: 1 },
      ],
      { p1: caixa(20, 20, 20), p2: caixa(20, 20, 20) },
    );
    expect(volumeDe(dois.dimensoes)).toBeGreaterThan(volumeDe(um.dimensoes));
  });
});
