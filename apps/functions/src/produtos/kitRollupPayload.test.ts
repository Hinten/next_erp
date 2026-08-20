import { describe, expect, it } from 'vitest';

import {
  CAMPOS_ROLLUP_KIT,
  MAX_SEED_IDS,
  lerValoresRollup,
  limitarSeeds,
  chaveComposicao,
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

  it('does NOT enqueue from a kit whose composition is unchanged — our OWN write', () => {
    // Without this the worker rewriting a kit would re-fan-out from that kit,
    // once per kit — ~2 000 wasted tasks per component edit.
    const comps = { c1: { quantidade: 1, limitarEstoque: true, timestamp: null } };
    expect(
      planejarRollupKit(
        'k1',
        doc({ ehKit: true, componentesKit: comps }),
        // A DIFFERENT object with the same content, as Firestore delivers it.
        doc({
          ehKit: true,
          alturaCm: 9,
          componentesKit: { c1: { quantidade: 1, limitarEstoque: true, timestamp: null } },
        }),
      ),
    ).toBeNull();
  });

  it('DOES enqueue from a kit whose COMPOSITION changed', () => {
    // The path `ehKit` alone silently dropped: an operator edits kit N's own
    // components, N's weight moves, and every kit containing N (nested — rare,
    // but exactly what the cascade machinery exists for) had no successor task.
    const payload = planejarRollupKit(
      'k1',
      doc({ ehKit: true, componentesKit: { c1: { quantidade: 1 } } }),
      doc({ ehKit: true, alturaCm: 9, componentesKit: { c1: { quantidade: 2 } } }),
    );
    expect(payload).not.toBeNull();
    expect(payload?.rootId).toBe('k1');
  });

  it('DOES enqueue when a component is flipped INTO a kit by the same write', () => {
    expect(
      planejarRollupKit(
        'p1',
        doc({ ehKit: false, componentesKit: null }),
        doc({ ehKit: true, alturaCm: 9, componentesKit: { c1: { quantidade: 1 } } }),
      ),
    ).not.toBeNull();
  });

  it('still does nothing for a kit whose composition changed but weight did not', () => {
    // Gate 4 still applies — a composition edit that happens to leave all five
    // derived values identical has nothing to propagate.
    expect(
      planejarRollupKit(
        'k1',
        doc({ ehKit: true, componentesKit: { c1: { quantidade: 1 } } }),
        doc({ ehKit: true, componentesKit: { c2: { quantidade: 1 } } }),
      ),
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

describe('chaveComposicao', () => {
  it('is content-based, so two deliveries of the same map compare EQUAL', () => {
    // The property the gate depends on: a reference or shallow `!==` compare
    // would call our own rollup write a composition change.
    const a = { c1: { quantidade: 2, limitarEstoque: true, timestamp: null } };
    const b = { c1: { quantidade: 2, limitarEstoque: true, timestamp: null } };
    expect(a).not.toBe(b);
    expect(chaveComposicao(a)).toBe(chaveComposicao(b));
  });

  it('is insertion-order independent but quantidade sensitive', () => {
    const q = (n: number) => ({ quantidade: n, limitarEstoque: true, timestamp: null });
    expect(chaveComposicao({ a: q(1), b: q(2) })).toBe(chaveComposicao({ b: q(2), a: q(1) }));
    expect(chaveComposicao({ a: q(1) })).not.toBe(chaveComposicao({ a: q(2) }));
  });

  it('treats null and empty as the same absence', () => {
    expect(chaveComposicao(null)).toBe(chaveComposicao({}));
  });
});
