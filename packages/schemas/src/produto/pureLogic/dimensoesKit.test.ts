import { describe, expect, it } from 'vitest';
import type { ComponentesKit } from '../collection/embedded/kit';
import { DIMENSOES_PADRAO, estimarDimensoes, type ProdutoMedidas } from './dimensoes';
import { CAMPOS_DIMENSOES_KIT, dimensoesDoKit } from './dimensoesKit';
import { KIT_PESO_BRUTO_FALLBACK_KG, KIT_PESO_LIQUIDO_FALLBACK_KG } from './precoCalculo';

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

const comp = (quantidade = 1): ComponentesKit[string] => ({
  quantidade,
  limitarEstoque: true,
  timestamp: null,
});

const kit = (entries: Record<string, number>): ComponentesKit =>
  Object.fromEntries(Object.entries(entries).map(([id, q]) => [id, comp(q)]));

describe('dimensoesDoKit — nothing to derive', () => {
  it('returns all nulls for an absent or empty component map', () => {
    for (const componentes of [null, undefined, {} as ComponentesKit]) {
      expect(dimensoesDoKit(componentes, {})).toEqual({
        pesoBrutoKg: null,
        pesoLiquidoKg: null,
        alturaCm: null,
        larguraCm: null,
        profundidadeCm: null,
      });
    }
  });

  it('leaves the BOX null when no component resolves one, rather than storing DIMENSOES_PADRAO', () => {
    // A fabricated 10x10x11 would read back as a real measurement and be trusted
    // by the freight quote. The weight half still computes, via its fallbacks.
    const r = dimensoesDoKit(kit({ c1: 1 }), { c1: medidas({ pesoBrutoKg: 2 }) });
    expect(r.alturaCm).toBeNull();
    expect(r.larguraCm).toBeNull();
    expect(r.profundidadeCm).toBeNull();
    expect(r.pesoBrutoKg).toBe(2);
    // Guard against the default silently leaking through some other path.
    expect([r.alturaCm, r.larguraCm, r.profundidadeCm]).not.toEqual([
      DIMENSOES_PADRAO.altura,
      DIMENSOES_PADRAO.largura,
      DIMENSOES_PADRAO.comprimento,
    ]);
  });
});

describe('dimensoesDoKit — weight', () => {
  it('sums peso x quantidade over the components', () => {
    const r = dimensoesDoKit(kit({ c1: 2, c2: 1 }), {
      c1: medidas({ pesoBrutoKg: 0.5, pesoLiquidoKg: 0.4 }),
      c2: medidas({ pesoBrutoKg: 1, pesoLiquidoKg: 0.9 }),
    });
    expect(r.pesoBrutoKg).toBe(2);
    expect(r.pesoLiquidoKg).toBe(1.7);
  });

  it('falls back to the parent weight for a component that has none', () => {
    const r = dimensoesDoKit(kit({ filho: 1 }), {
      filho: medidas({ paiId: 'pai' }),
      pai: medidas({ pesoBrutoKg: 3, pesoLiquidoKg: 2.5 }),
    });
    expect(r.pesoBrutoKg).toBe(3);
    expect(r.pesoLiquidoKg).toBe(2.5);
  });

  it('uses the crude per-component defaults when nothing resolves', () => {
    const r = dimensoesDoKit(kit({ c1: 2 }), { c1: medidas() });
    expect(r.pesoBrutoKg).toBe(KIT_PESO_BRUTO_FALLBACK_KG * 2);
    expect(r.pesoLiquidoKg).toBe(KIT_PESO_LIQUIDO_FALLBACK_KG * 2);
  });

  it('treats a stored 0 as a real own weight, not as missing', () => {
    // `resolveComponentPeso`'s rule, and it differs from `pesoPedido`'s.
    const r = dimensoesDoKit(kit({ filho: 1 }), {
      filho: medidas({ pesoBrutoKg: 0, pesoLiquidoKg: 0, paiId: 'pai' }),
      pai: medidas({ pesoBrutoKg: 9, pesoLiquidoKg: 9 }),
    });
    expect(r.pesoBrutoKg).toBe(0);
  });
});

describe('dimensoesDoKit — box', () => {
  it('boxes the components without the packing allowance', () => {
    const componentes = kit({ c1: 1, c2: 1 });
    const mapa = {
      c1: medidas({ alturaCm: 2, larguraCm: 20, profundidadeCm: 30 }),
      c2: medidas({ alturaCm: 1, larguraCm: 15, profundidadeCm: 20 }),
    };
    const r = dimensoesDoKit(componentes, mapa);
    const esperado = estimarDimensoes(
      [
        { produtoUid: 'c1', quantidade: 1 },
        { produtoUid: 'c2', quantidade: 1 },
      ],
      mapa,
      { fatorOcupacao: 1 },
    );
    expect([r.alturaCm, r.larguraCm, r.profundidadeCm]).toEqual([
      esperado.dimensoes.altura,
      esperado.dimensoes.largura,
      esperado.dimensoes.comprimento,
    ]);
  });

  it('maps the wire comprimento onto produto.profundidadeCm', () => {
    // The axis rename is the easiest thing to get backwards in this area.
    const mapa = { c1: medidas({ alturaCm: 2, larguraCm: 8, profundidadeCm: 40 }) };
    const r = dimensoesDoKit(kit({ c1: 1 }), mapa);
    const esperado = estimarDimensoes([{ produtoUid: 'c1', quantidade: 1 }], mapa, {
      fatorOcupacao: 1,
    });
    expect(r.profundidadeCm).toBe(esperado.dimensoes.comprimento);
    expect(r.alturaCm).toBe(esperado.dimensoes.altura);
  });

  it('falls back to the parent box for a component with no dimensions of its own', () => {
    const r = dimensoesDoKit(kit({ filho: 1 }), {
      filho: medidas({ pesoBrutoKg: 1, paiId: 'pai' }),
      pai: medidas({ alturaCm: 3, larguraCm: 20, profundidadeCm: 25 }),
    });
    expect(r.alturaCm).not.toBeNull();
    expect(r.larguraCm).not.toBeNull();
    expect(r.profundidadeCm).not.toBeNull();
  });

  it('grows with quantidade', () => {
    const mapa = { c1: medidas({ alturaCm: 10, larguraCm: 10, profundidadeCm: 10 }) };
    const um = dimensoesDoKit(kit({ c1: 1 }), mapa);
    const muitos = dimensoesDoKit(kit({ c1: 12 }), mapa);
    const vol = (d: typeof um) => d.alturaCm! * d.larguraCm! * d.profundidadeCm!;
    expect(vol(muitos)).toBeGreaterThan(vol(um));
  });
});

describe('CAMPOS_DIMENSOES_KIT', () => {
  it('names exactly the keys the rollup produces', () => {
    // Mutating the RESULT rather than iterating the constant, so a field added
    // to `DimensoesKit` and forgotten here fails instead of passing vacuously.
    const produzidos = Object.keys(dimensoesDoKit(kit({ c1: 1 }), { c1: medidas() })).sort();
    expect([...CAMPOS_DIMENSOES_KIT].sort()).toEqual(produzidos);
  });
});
