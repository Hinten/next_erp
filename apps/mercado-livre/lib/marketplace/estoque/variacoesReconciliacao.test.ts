import { describe, expect, it } from 'vitest';
import type { MlItem } from '@delfrance/integrations-mercado-livre';

import { idDaVariacao, idsDasVariacoesVivas, planejarPoda } from '../anuncios/variacoesFantasma';
import { reconciliarVariations } from './variacoesReconciliacao';

/** A legacy-model listing: `family_name` absent, `variations[]` present. */
const item = (variations: unknown[], over: Partial<MlItem> = {}): MlItem =>
  ({ id: 'MLB111', status: 'active', variations, ...over }) as MlItem;

const ok = (r: ReturnType<typeof reconciliarVariations>) => {
  if (!r.ok) throw new Error(`esperava ok, veio recusa ${r.reason}`);
  return r;
};

describe('reconciliarVariations — the array is completed, never trimmed', () => {
  it('carries a variation the payload OMITS at ML own quantity', () => {
    // The `kit-virtual` / `status-nao-enviavel` case: `buildSendTasks` priced
    // one child and dropped the other. Today that array would go out as-is and
    // DELETE variation 2.
    const r = ok(
      reconciliarVariations(
        [{ id: 1, available_quantity: 7 }],
        item([
          { id: 1, available_quantity: 3 },
          { id: 2, available_quantity: 42 },
        ]),
      ),
    );
    expect(r.variations).toEqual([
      { id: 1, available_quantity: 7 }, // ours
      { id: 2, available_quantity: 42 }, // ML's, verbatim
    ]);
    expect(r.fantasmas).toEqual([]);
  });

  it('THE CASE NO LOCAL CHECK CAN SEE: a live variation we hold no link for', () => {
    // Nothing was skip-logged — there is no child row for it at all, so
    // `variations.length === row.children.length` and every planner-side
    // completeness check reads GREEN while the PUT deletes it.
    const r = ok(
      reconciliarVariations(
        [{ id: 1, available_quantity: 7 }],
        item([
          { id: 1, available_quantity: 3 },
          { id: 999, available_quantity: 5 },
        ]),
      ),
    );
    expect(r.variations).toContainEqual({ id: 999, available_quantity: 5 });
  });

  it('NEAR-MISS CONTROL: an already-complete payload comes out unchanged', () => {
    // Proves the merge does not disturb the ordinary path — if this ever starts
    // differing, the completion is rewriting quantities it must only preserve.
    const patch = [
      { id: 1, available_quantity: 7 },
      { id: 2, available_quantity: 8 },
    ];
    const r = ok(
      reconciliarVariations(
        patch,
        item([
          { id: 1, available_quantity: 3 },
          { id: 2, available_quantity: 4 },
        ]),
      ),
    );
    expect(r.variations).toEqual(patch);
  });

  it('preserves ML ORDER, not the payload one (legacy ranks variations for display)', () => {
    const r = ok(
      reconciliarVariations(
        [
          { id: 2, available_quantity: 8 },
          { id: 1, available_quantity: 7 },
        ],
        item([
          { id: 1, available_quantity: 3 },
          { id: 2, available_quantity: 4 },
        ]),
      ),
    );
    expect(r.variations.map((v) => v.id)).toEqual([1, 2]);
  });

  it('carries a live quantity of ZERO rather than treating it as absent', () => {
    // `0` is a real quantity (ML pauses the variation out_of_stock at it) and is
    // falsy — a `??`/`||` slip here would invent a number for a paused variation.
    const r = ok(
      reconciliarVariations(
        [{ id: 1, available_quantity: 7 }],
        item([
          { id: 1, available_quantity: 3 },
          { id: 2, available_quantity: 0 },
        ]),
      ),
    );
    expect(r.variations).toContainEqual({ id: 2, available_quantity: 0 });
  });

  it('accepts a payload quantity of ZERO as OURS, not as missing', () => {
    const r = ok(
      reconciliarVariations(
        [{ id: 2, available_quantity: 0 }],
        item([{ id: 2, available_quantity: 9 }]),
      ),
    );
    expect(r.variations).toEqual([{ id: 2, available_quantity: 0 }]);
  });
});

describe('reconciliarVariations — the id fold, and where it STOPS', () => {
  it('folds number and string: ML has sent variation ids both ways', () => {
    const r = ok(
      reconciliarVariations(
        [{ id: 15092589430, available_quantity: 7 }],
        item([{ id: '15092589430', available_quantity: 3 }]),
      ),
    );
    // Ours wins the quantity; ML's own id value is echoed back verbatim.
    expect(r.variations).toEqual([{ id: '15092589430', available_quantity: 7 }]);
    expect(r.fantasmas).toEqual([]);
  });

  it('NEAR-MISS: 123 and 1230 stay DISTINCT', () => {
    const r = ok(
      reconciliarVariations(
        [{ id: 123, available_quantity: 7 }],
        item([
          { id: '1230', available_quantity: 3 },
          { id: '123', available_quantity: 4 },
        ]),
      ),
    );
    expect(r.variations).toEqual([
      { id: '1230', available_quantity: 3 }, // untouched
      { id: '123', available_quantity: 7 }, // ours
    ]);
  });

  it('NEAR-MISS: 01 and 1 stay DISTINCT — the fold is String(x), never Number(x)', () => {
    // A numeric fold would make these the same variation and silently apply our
    // quantity to the wrong row (the #1372 shape).
    const r = ok(
      reconciliarVariations(
        [{ id: 1, available_quantity: 7 }],
        item([{ id: '01', available_quantity: 3 }]),
      ),
    );
    expect(r.variations).toEqual([{ id: '01', available_quantity: 3 }]);
    expect(r.fantasmas).toEqual(['1']);
  });

  it('reports a payload id ML no longer knows as a PHANTOM, and omits it', () => {
    // A #707 phantom. It belongs in no body — but it must be REPORTED, because
    // completing the array is exactly what stops ML from ever answering
    // `item.variations.invalid` about it again.
    const r = ok(
      reconciliarVariations(
        [
          { id: 1, available_quantity: 7 },
          { id: 404, available_quantity: 1 },
        ],
        item([{ id: 1, available_quantity: 3 }]),
      ),
    );
    expect(r.variations).toEqual([{ id: 1, available_quantity: 7 }]);
    expect(r.fantasmas).toEqual(['404']);
  });
});

describe('the id fold is SHARED with the prune — one implementation, both sides', () => {
  // The two modules answer the same question about the same wire values from
  // opposite sides: which live ids exist, versus which stored ids are phantoms.
  // A divergence makes the completion carry a variation the prune calls dead, or
  // prune one the send just updated — so the agreement is pinned here rather
  // than asserted in a comment.
  it('the completion and idsDasVariacoesVivas fold the same values identically', () => {
    const ids = [15092589430, '15092589430', '01', 1, '123', '1230'] as const;
    const vivas = ids.map((id) => ({ id, available_quantity: 1 }));

    // Live side, via the prune's helper.
    const doPrune = idsDasVariacoesVivas(item(vivas as unknown[]));
    // Completion side: every live id it emitted, folded the same way.
    const daCompletacao = new Set(
      ok(reconciliarVariations([], item(vivas as unknown[]))).variations.map((v) =>
        idDaVariacao(v.id),
      ),
    );

    expect(daCompletacao).toEqual(doPrune);
  });

  it('a NON-FINITE id is unnameable on BOTH sides — the disagreement that existed', () => {
    // `idsDasVariacoesVivas` used to fold NaN to the string 'NaN' while the
    // stored-side helper answered null, so one half of the same diff saw a live
    // id the other could never match.
    expect(idDaVariacao(Number.NaN)).toBeNull();
    expect(idsDasVariacoesVivas(item([{ id: Number.NaN, available_quantity: 1 }]))).toEqual(
      new Set(),
    );
    // The completion takes the safe direction from the same answer: it refuses
    // to send rather than omit a variation it cannot name.
    expect(
      reconciliarVariations(
        [{ id: 1, available_quantity: 7 }],
        item([{ id: Number.NaN, available_quantity: 1 }]),
      ),
    ).toEqual({ ok: false, reason: 'variacao-viva-sem-id' });
    // And the prune agrees the stored side is unnameable, so it marks nothing.
    expect(
      planejarPoda([{ docId: 'v1', produtoId: 'C1', raw: { id: Number.NaN } }], new Set()),
    ).toEqual([]);
  });
});

describe('reconciliarVariations — refuses rather than send an unprovable array', () => {
  it('refuses a User-Products listing (family_name present)', () => {
    expect(
      reconciliarVariations(
        [{ id: 1, available_quantity: 7 }],
        item([{ id: 1, available_quantity: 3 }], { family_name: 'Camiseta' }),
      ),
    ).toEqual({ ok: false, reason: 'modelo-divergente' });
  });

  it('refuses a listing reporting NO variations — empty and absent alike', () => {
    expect(reconciliarVariations([{ id: 1, available_quantity: 7 }], item([]))).toEqual({
      ok: false,
      reason: 'modelo-divergente',
    });
    expect(
      reconciliarVariations([{ id: 1, available_quantity: 7 }], { id: 'MLB111' } as MlItem),
    ).toEqual({ ok: false, reason: 'modelo-divergente' });
  });

  it('refuses when a live variation has no id — it cannot be named, so it cannot be kept', () => {
    expect(
      reconciliarVariations(
        [{ id: 1, available_quantity: 7 }],
        item([
          { id: 1, available_quantity: 3 },
          { id: null, available_quantity: 5 },
        ]),
      ),
    ).toEqual({ ok: false, reason: 'variacao-viva-sem-id' });
  });

  it('refuses a live variation with an unusable available_quantity — 0 is NOT a safe default', () => {
    // Inventing 0 would pause the variation out_of_stock; omitting it deletes it.
    for (const atual of [null, undefined, 1.5, -1, '3']) {
      expect(
        reconciliarVariations(
          [{ id: 1, available_quantity: 7 }],
          item([
            { id: 1, available_quantity: 3 },
            { id: 2, available_quantity: atual },
          ]),
        ),
      ).toEqual({ ok: false, reason: 'quantidade-viva-ausente' });
    }
  });

  it('does NOT refuse when the unusable quantity belongs to a variation WE are setting', () => {
    // Ours replaces it, so there is nothing to preserve and nothing to refuse.
    const r = ok(
      reconciliarVariations(
        [{ id: 2, available_quantity: 7 }],
        item([{ id: 2, available_quantity: null }]),
      ),
    );
    expect(r.variations).toEqual([{ id: 2, available_quantity: 7 }]);
  });
});
