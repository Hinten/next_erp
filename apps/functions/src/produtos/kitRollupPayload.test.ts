import { describe, expect, it } from 'vitest';

import {
  CAMPOS_ROLLUP_KIT,
  MAX_SEED_IDS,
  lerValoresRollup,
  limitarSeeds,
  kitRollupPayloadSchema,
  planejarRollupKit,
  valoresRollupDiferem,
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

/** A raw produto doc carrying the five rollup fields. */
const doc = (over: Record<string, unknown> = {}) => ({ ...valores(), ...over });

describe('lerValoresRollup', () => {
  it('reads the five fields off a raw document', () => {
    expect(lerValoresRollup(doc())).toEqual(valores());
  });

  it('coalesces a missing, null or non-finite value to null', () => {
    expect(lerValoresRollup({ pesoBrutoKg: null, alturaCm: NaN, larguraCm: 'x' })).toEqual({
      pesoBrutoKg: null,
      pesoLiquidoKg: null,
      alturaCm: null,
      larguraCm: null,
      profundidadeCm: null,
    });
    expect(lerValoresRollup(undefined)).toEqual({
      pesoBrutoKg: null,
      pesoLiquidoKg: null,
      alturaCm: null,
      larguraCm: null,
      profundidadeCm: null,
    });
  });

  it('keeps a stored 0 — it is a real value, not "missing"', () => {
    expect(lerValoresRollup({ pesoBrutoKg: 0 }).pesoBrutoKg).toBe(0);
  });
});

describe('valoresRollupDiferem', () => {
  it('is false for identical values', () => {
    expect(valoresRollupDiferem(valores(), valores())).toBe(false);
  });

  it('detects a change in EACH of the five fields', () => {
    // Driven off the field list and mutating the object, so a field dropped from
    // the comparison fails here instead of passing vacuously.
    for (const campo of CAMPOS_ROLLUP_KIT) {
      expect(
        valoresRollupDiferem(valores(), valores({ [campo]: 99 })),
        `${campo} must be compared`,
      ).toBe(true);
    }
  });

  it('treats null-vs-value as a difference', () => {
    expect(valoresRollupDiferem(valores({ alturaCm: null }), valores())).toBe(true);
  });
});

describe('planejarRollupKit — the gate', () => {
  it('enqueues when a weight changed', () => {
    const payload = planejarRollupKit('p1', doc(), doc({ pesoBrutoKg: 2 }));
    expect(payload).toMatchObject({
      rootId: 'p1',
      seedIds: null,
      seedOffset: 0,
      cursor: null,
      depth: 0,
      visitados: [],
    });
    expect(payload?.rootValores.pesoBrutoKg).toBe(2);
  });

  it('enqueues when any single dimension changed', () => {
    for (const campo of ['alturaCm', 'larguraCm', 'profundidadeCm'] as const) {
      expect(planejarRollupKit('p1', doc(), doc({ [campo]: 42 })), campo).not.toBeNull();
    }
  });

  it('does NOT enqueue when no rollup field moved — the zero-extra-reads rule', () => {
    // The ordinary produto save: nome, preço, foto, marketplace denorm churn.
    expect(planejarRollupKit('p1', doc(), doc({ nome: 'novo' }))).toBeNull();
    expect(planejarRollupKit('p1', doc(), doc())).toBeNull();
  });

  it('does NOT enqueue on a delete', () => {
    expect(planejarRollupKit('p1', doc(), undefined)).toBeNull();
  });

  it('does NOT enqueue on a create — nothing can list it as a component yet', () => {
    expect(planejarRollupKit('p1', undefined, doc())).toBeNull();
  });

  it('does NOT enqueue from a kit — those five fields are this rollup OUTPUT', () => {
    // Without this the worker rewriting a kit would re-fan-out from that kit,
    // once per kit, forever. Nested kits are the worker probe's job instead.
    expect(
      planejarRollupKit('k1', doc({ ehKit: true }), doc({ ehKit: true, alturaCm: 9 })),
    ).toBeNull();
  });

  it('still enqueues for a produto that merely HAS components but is not a kit', () => {
    expect(
      planejarRollupKit('p1', doc({ ehKit: false }), doc({ ehKit: false, alturaCm: 9 })),
    ).not.toBeNull();
  });
});

describe('kitRollupPayloadSchema', () => {
  it('accepts a minimal payload and fills the walk defaults', () => {
    const parsed = kitRollupPayloadSchema.parse({ rootId: 'p1', rootValores: valores() });
    expect(parsed).toMatchObject({ seedIds: null, seedOffset: 0, cursor: null, depth: 0 });
    expect(parsed.visitados).toEqual([]);
  });

  it('round-trips what planejarRollupKit produces', () => {
    const payload = planejarRollupKit('p1', doc(), doc({ pesoBrutoKg: 2 }))!;
    expect(kitRollupPayloadSchema.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it('rejects a payload with no rootId', () => {
    expect(() => kitRollupPayloadSchema.parse({ rootValores: valores() })).toThrow();
  });
});

describe('limitarSeeds', () => {
  it('dedupes and reports nothing dropped under the cap', () => {
    expect(limitarSeeds(['a', 'b', 'a'])).toEqual({ seeds: ['a', 'b'], descartados: [] });
  });

  it('reports what it dropped rather than truncating silently', () => {
    const ids = Array.from({ length: MAX_SEED_IDS + 3 }, (_, i) => `p${i}`);
    const { seeds, descartados } = limitarSeeds(ids);
    expect(seeds).toHaveLength(MAX_SEED_IDS);
    expect(descartados).toHaveLength(3);
  });
});
