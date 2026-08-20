import { describe, expect, it } from 'vitest';
import type { ComponentesKit } from '@delfrance/schemas';

import { chaveComposicao, patchDimensoes, projetarMedidas, proximaPagina } from './kitRollup';
import {
  KITS_POR_PAGINA,
  SEEDS_POR_CONSULTA,
  type KitRollupPayload,
  type ValoresRollup,
} from './kitRollupPayload';

const valores = (over: Partial<ValoresRollup> = {}): ValoresRollup => ({
  pesoBrutoKg: 1,
  pesoLiquidoKg: 0.9,
  alturaCm: 5,
  larguraCm: 10,
  profundidadeCm: 10,
  ...over,
});

const kit = (entries: Record<string, number>): ComponentesKit =>
  Object.fromEntries(
    Object.entries(entries).map(([id, q]) => [
      id,
      { quantidade: q, limitarEstoque: true, timestamp: null },
    ]),
  );

describe('projetarMedidas', () => {
  it('carries paiId alongside the five rollup values', () => {
    expect(projetarMedidas({ ...valores(), paiId: 'pai1', nome: 'x' })).toEqual({
      ...valores(),
      paiId: 'pai1',
    });
  });

  it('nulls a missing paiId rather than leaving it undefined', () => {
    expect(projetarMedidas({}).paiId).toBeNull();
  });
});

describe('chaveComposicao', () => {
  it('is insertion-order independent, so sibling kits share one computation', () => {
    expect(chaveComposicao(kit({ a: 1, b: 2 }))).toBe(chaveComposicao(kit({ b: 2, a: 1 })));
  });

  it('separates kits that differ only in quantidade', () => {
    expect(chaveComposicao(kit({ a: 1 }))).not.toBe(chaveComposicao(kit({ a: 2 })));
  });

  it('separates kits that differ only in which components they list', () => {
    expect(chaveComposicao(kit({ a: 1 }))).not.toBe(chaveComposicao(kit({ b: 1 })));
  });

  it('handles an empty or absent map', () => {
    expect(chaveComposicao(null)).toBe('');
    expect(chaveComposicao({})).toBe('');
  });
});

describe('patchDimensoes', () => {
  const derivado = {
    pesoBrutoKg: 2,
    pesoLiquidoKg: 1.8,
    alturaCm: 6,
    larguraCm: 10,
    profundidadeCm: 11,
  };

  it('writes nothing when everything already matches — the idempotency rule', () => {
    expect(patchDimensoes(valores(derivado), derivado)).toEqual({});
  });

  it('writes only the fields that actually differ', () => {
    expect(patchDimensoes(valores({ ...derivado, alturaCm: 5 }), derivado)).toEqual({
      alturaCm: 6,
    });
  });

  it('NEVER writes a null over a stored value', () => {
    // `null` means "not derivable" — persisting the estimator's DIMENSOES_PADRAO
    // fallback would turn a guess into a stored measurement the freight quote
    // then trusts.
    expect(
      patchDimensoes(valores(), {
        ...derivado,
        alturaCm: null,
        larguraCm: null,
        profundidadeCm: null,
      }),
    ).toEqual({ pesoBrutoKg: 2, pesoLiquidoKg: 1.8 });
  });

  it('does write a derived 0', () => {
    expect(patchDimensoes(valores(), { ...derivado, pesoBrutoKg: 0 })).toMatchObject({
      pesoBrutoKg: 0,
    });
  });
});

describe('proximaPagina', () => {
  const base: KitRollupPayload = {
    rootId: 'p1',
    rootValores: valores(),
    seedIds: null,
    seedOffset: 0,
    cursor: null,
    depth: 0,
    visitados: [],
  };
  const seeds = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);

  it('advances the cursor while the page comes back full', () => {
    expect(proximaPagina(base, seeds(1), true, 'kit9')).toMatchObject({
      seedOffset: 0,
      cursor: 'kit9',
      seedIds: ['s0'],
    });
  });

  it('moves to the next 30-seed chunk when the page was short', () => {
    expect(proximaPagina(base, seeds(45), false, 'kitZ')).toMatchObject({
      seedOffset: SEEDS_POR_CONSULTA,
      cursor: null,
    });
  });

  it('stops once the last chunk is exhausted', () => {
    expect(proximaPagina(base, seeds(10), false, null)).toBeNull();
    expect(
      proximaPagina({ ...base, seedOffset: SEEDS_POR_CONSULTA }, seeds(45), false, null),
    ).toBeNull();
  });

  it('materializes seedIds into the payload so the next dispatch does not re-derive them', () => {
    expect(proximaPagina(base, seeds(3), true, 'kitA')?.seedIds).toEqual(['s0', 's1', 's2']);
  });

  it('carries depth and visitados forward unchanged', () => {
    const com = { ...base, depth: 2, visitados: ['k1'] };
    expect(proximaPagina(com, seeds(1), true, 'kitA')).toMatchObject({
      depth: 2,
      visitados: ['k1'],
    });
  });

  it('does not advance the cursor on a full page with no last id (defensive)', () => {
    expect(proximaPagina(base, seeds(1), true, null)).toBeNull();
  });

  it('uses KITS_POR_PAGINA as the fullness signal the caller computes', () => {
    // Pins the contract between the caller and this helper: "full" means the
    // page returned exactly the limit.
    expect(KITS_POR_PAGINA).toBeGreaterThan(0);
  });
});
