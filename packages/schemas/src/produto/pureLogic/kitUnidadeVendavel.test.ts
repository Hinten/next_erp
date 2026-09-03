import { describe, expect, it } from 'vitest';

import type { ComponentesKit, Kit } from '../collection/embedded/kit';
import { reapontarComponentesKit } from './kitUnidadeVendavel';

function kit(over: Partial<Kit> = {}): Kit {
  return { quantidade: 1, limitarEstoque: true, timestamp: null, ...over };
}

/**
 * The corpus this fold runs against: `pai` is a family of one whose sellable unit
 * is `filho`; `muitos` is a family of MANY (no single unit to pick); `avulso` is
 * a childless legacy produto. Everything not named here resolves to itself,
 * which is what `unidadeVendavel` does for a child, a childless produto and a
 * family of many alike.
 */
const RESOLVER = (id: string): string => (id === 'pai' ? 'filho' : id);

describe('reapontarComponentesKit — what moves', () => {
  it('moves a family-of-one parent onto its sole member', () => {
    const plano = reapontarComponentesKit({ pai: kit({ quantidade: 3 }) }, RESOLVER);
    expect(plano.mudou).toBe(true);
    expect(plano.componentesKit).toEqual({ filho: kit({ quantidade: 3 }) });
    expect(plano.componentesKitKeys).toEqual(['filho']);
    expect(plano.movidos).toEqual([{ de: 'pai', para: 'filho' }]);
  });

  it('re-derives the keys array sorted, because it feeds an array-contains', () => {
    const plano = reapontarComponentesKit({ zzz: kit(), pai: kit(), aaa: kit() }, RESOLVER);
    expect(plano.componentesKitKeys).toEqual(['aaa', 'filho', 'zzz']);
  });

  /**
   * ⚠️ The case above passes even with the OUTPUT sort removed, because sorting
   * the INPUT keys already lands the targets in order — a mutation test found
   * exactly that hole. Here the resolution REORDERS them (`aaa`→`zzz`,
   * `bbb`→`ccc`), so insertion order is `['zzz','ccc']` and only a real sort
   * yields `['ccc','zzz']`.
   *
   * It matters beyond tidiness: `mesmaListaDeChaves` compares this array
   * ORDER-SENSITIVELY (`familia.ts`), so an unsorted one reads as "the operator
   * diverged this member" and freezes the whole kit group for good.
   */
  it('sorts the keys even when the resolution reorders them', () => {
    const plano = reapontarComponentesKit(
      { aaa: kit(), bbb: kit() },
      (id) => ({ aaa: 'zzz', bbb: 'ccc' })[id] ?? id,
    );
    expect(plano.componentesKitKeys).toEqual(['ccc', 'zzz']);
  });

  // ⚠️ The near-miss half. A family of MANY has no single sellable unit, so the
  // resolver answers with the parent itself and this must leave it alone —
  // picking one arbitrary variation would attribute the kit's draw to the wrong
  // produto, which is the whole harm `filhoUnicoId` exists to avoid.
  it('leaves a family-of-many parent exactly where it is', () => {
    const plano = reapontarComponentesKit({ muitos: kit({ quantidade: 2 }) }, RESOLVER);
    expect(plano.mudou).toBe(false);
    expect(plano.componentesKit).toEqual({ muitos: kit({ quantidade: 2 }) });
    expect(plano.movidos).toEqual([]);
  });

  // ...and the other near-miss: a component already naming the sellable unit.
  // `unidadeVendavel` is a FIXPOINT, which is the only reason a second run of the
  // migration — or the trigger firing after it — is a no-op rather than a churn
  // write on every kit in the corpus.
  it('is a fixpoint: applying it twice equals applying it once', () => {
    const uma = reapontarComponentesKit({ pai: kit({ quantidade: 3 }) }, RESOLVER);
    const duas = reapontarComponentesKit(uma.componentesKit, RESOLVER);
    expect(duas.componentesKit).toEqual(uma.componentesKit);
    expect(duas.mudou).toBe(false);
    expect(duas.movidos).toEqual([]);
  });

  it('leaves a childless legacy produto alone', () => {
    const plano = reapontarComponentesKit({ avulso: kit() }, RESOLVER);
    expect(plano.mudou).toBe(false);
  });

  it('treats an empty or absent map as nothing to do', () => {
    for (const vazio of [null, undefined, {}] as const) {
      const plano = reapontarComponentesKit(vazio, RESOLVER);
      expect(plano.mudou).toBe(false);
      expect(plano.componentesKitKeys).toBeNull();
    }
  });
});

/**
 * ⛔ The collision, and it is the part that can silently lose data.
 *
 * A kit can legitimately list BOTH a family-of-one parent and its own sole
 * member — the picker shows the two with identical nome and SKU and no badge, so
 * an operator cannot tell them apart. They are one physical produto drawing from
 * one pool, so the entries have to fold; keeping one and dropping the other
 * understates what the sale removes, which ships as an oversell.
 */
describe('reapontarComponentesKit — the collision', () => {
  it('SUMS the quantidade when two components fold onto one', () => {
    const plano = reapontarComponentesKit(
      { pai: kit({ quantidade: 2 }), filho: kit({ quantidade: 5 }) },
      RESOLVER,
    );
    expect(plano.mudou).toBe(true);
    expect(plano.componentesKit).toEqual({ filho: kit({ quantidade: 7 }) });
    expect(plano.componentesKitKeys).toEqual(['filho']);
    expect(plano.colisoes).toEqual([{ alvo: 'filho', de: ['filho', 'pai'], quantidadeSomada: 7 }]);
  });

  // ⚠️ The near-miss that keeps the fold honest: two DIFFERENT produtos must
  // stay two entries, however alike they look. A fold that collapsed these would
  // make a kit needing 1+1 of two produtos read as needing 2 of one.
  it('keeps two components that resolve to different ids as two entries', () => {
    const plano = reapontarComponentesKit(
      { pai: kit({ quantidade: 2 }), avulso: kit({ quantidade: 5 }) },
      RESOLVER,
    );
    expect(plano.componentesKit).toEqual({
      filho: kit({ quantidade: 2 }),
      avulso: kit({ quantidade: 5 }),
    });
    expect(plano.colisoes).toEqual([]);
  });

  it('keeps the alphabetically-first entry’s timestamp and passthrough fields', () => {
    const plano = reapontarComponentesKit(
      {
        pai: { ...kit({ quantidade: 2, timestamp: 222 }), legado: 'do-pai' } as Kit,
        filho: { ...kit({ quantidade: 5, timestamp: 111 }), legado: 'do-filho' } as Kit,
      },
      RESOLVER,
    );
    // 'filho' sorts before 'pai', so it is the survivor — deterministic, and NOT
    // dependent on Firestore's map ordering.
    expect(plano.componentesKit).toEqual({
      filho: { quantidade: 7, limitarEstoque: true, timestamp: 111, legado: 'do-filho' },
    });
  });

  it('folds a uniformly non-limiting pair without turning it into a limiting one', () => {
    const plano = reapontarComponentesKit(
      {
        pai: kit({ quantidade: 2, limitarEstoque: false }),
        filho: kit({ quantidade: 5, limitarEstoque: false }),
      },
      RESOLVER,
    );
    expect(plano.componentesKit).toEqual({
      filho: kit({ quantidade: 7, limitarEstoque: false }),
    });
  });

  /**
   * ⛔ The refusal. `limitarEstoque` decides BOTH halves at once — a `false`
   * component neither caps the kit's availability nor is decremented on sale
   * (`estoquePlan.ts:99`) — and the schema carries one flag per key. So there is
   * no merge that is right: summing to 7 constrained units removes 7 on a sale
   * that must remove 2; keeping the 2 loses the 5 the cost/weight rollups read.
   */
  it('REFUSES a mixed collision and leaves both entries untouched', () => {
    const entrada: ComponentesKit = {
      pai: kit({ quantidade: 5, limitarEstoque: false }),
      filho: kit({ quantidade: 2, limitarEstoque: true }),
    };
    const plano = reapontarComponentesKit(entrada, RESOLVER);
    expect(plano.componentesKit).toEqual(entrada);
    expect(plano.componentesKitKeys).toEqual(['filho', 'pai']);
    expect(plano.movidos).toEqual([]);
    // ⚠️ `mudou: false` is what stops the caller writing a document it did not
    // change — but the collision is still REPORTED, because that kit still names
    // a produto with no available stock and needs a human.
    expect(plano.mudou).toBe(false);
    expect(plano.colisoes).toEqual([
      { alvo: 'filho', de: ['filho', 'pai'], quantidadeSomada: null },
    ]);
  });

  it('still moves the other components when one collision is refused', () => {
    const plano = reapontarComponentesKit(
      {
        pai: kit({ quantidade: 5, limitarEstoque: false }),
        filho: kit({ quantidade: 2, limitarEstoque: true }),
        outroPai: kit({ quantidade: 1 }),
      },
      (id) => (id === 'pai' ? 'filho' : id === 'outroPai' ? 'outroFilho' : id),
    );
    expect(plano.mudou).toBe(true);
    expect(plano.componentesKit).toEqual({
      pai: kit({ quantidade: 5, limitarEstoque: false }),
      filho: kit({ quantidade: 2, limitarEstoque: true }),
      outroFilho: kit({ quantidade: 1 }),
    });
  });
});

describe('reapontarComponentesKit — the shapes it refuses to damage', () => {
  // The migrated corpus soft-parses, so an entry can be raw junk. It is invisible
  // to every reader (`componentesKitEntries` filters it) — but a REWRITE that
  // dropped it would be destroying stored data on a document nobody asked to
  // clean up.
  it('keeps a malformed entry rather than dropping it', () => {
    const plano = reapontarComponentesKit({ pai: 'lixo' as unknown as Kit }, RESOLVER);
    expect(plano.componentesKit).toEqual({ filho: 'lixo' });
  });

  it('lets a well-formed entry win a collision against a malformed one', () => {
    const plano = reapontarComponentesKit(
      { pai: kit({ quantidade: 4 }), filho: null as unknown as Kit },
      RESOLVER,
    );
    expect(plano.componentesKit).toEqual({ filho: kit({ quantidade: 4 }) });
  });

  // ⚠️ A resolver is required to be TOTAL, but a drifted `filhoUnicoId` of `''`
  // would otherwise relocate a component onto an empty key — losing it from every
  // reader at once. Refusing to move beats trusting the caller.
  it('leaves the component in place when the resolver answers with nothing', () => {
    const plano = reapontarComponentesKit({ pai: kit() }, () => '');
    expect(plano.mudou).toBe(false);
    expect(plano.componentesKit).toEqual({ pai: kit() });
  });
});
