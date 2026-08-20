import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoredToken } from '@delfrance/integrations-freight-br';

/**
 * `save()`'s transaction was completely untested before #966 —
 * `melhorEnvio.test.ts` mocks this whole module away, and the app has no
 * emulator lane. These drive it against a fake `Firestore` so the ADR 0011
 * tier-2 guard (update-if-newer on `expirationDate`) is pinned by something.
 *
 * The collection handle is faked rather than the Admin SDK: `parseRead` is
 * identity here, which is enough — the guard reads exactly one field and the
 * real schema (`tokenMelEnvSchema`) already has its own tests.
 */
const h = vi.hoisted(() => ({
  parse: vi.fn((t: unknown) => ({ ...(t as object), __parsed: true })),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  tokenMelEnvCollection: {
    ref: () => ({ __kind: 'coll' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ __kind: 'doc', id }),
    docPath: (_ctx: unknown, id: string) => `int_frete/int-1/tokenMelEnv/${id}`,
    parse: (t: unknown) => h.parse(t),
    parseRead: (data: unknown) => data,
  },
}));

const { createFirestoreTokenStore } = await import('./tokenStore');

const NOW = 1_700_000_000_000;

// `mockClear`, not `mockReset` — the latter would drop the implementation the
// hoisted `vi.fn` was constructed with and every `parse` would return undefined.
beforeEach(() => {
  h.parse.mockClear();
});

function tok(over: Partial<StoredToken> = {}): StoredToken {
  return {
    access_token: 'A',
    refresh_token: 'R',
    expirationDate: NOW + 30 * 24 * 60 * 60_000,
    ...over,
  };
}

interface TxRecord {
  readonly sets: { id: string; data: unknown }[];
  readonly deletes: string[];
}

/**
 * A fake `Firestore` whose transaction exposes what the callback did. `docs` is
 * what `tx.get(collRef)` returns — the whole `tokenMelEnv` lineage, keyed by id,
 * exactly as the real store reads it.
 */
function fakeDb(docs: Record<string, StoredToken>): { db: never; tx: TxRecord } {
  const tx: TxRecord = { sets: [], deletes: [] };
  const db = {
    runTransaction: async (fn: (t: unknown) => Promise<void>) =>
      fn({
        get: async () => ({
          docs: Object.entries(docs).map(([id, data]) => ({
            id,
            data: () => data,
            ref: { __kind: 'doc', id },
          })),
        }),
        set: (ref: { id: string }, data: unknown) => tx.sets.push({ id: ref.id, data }),
        delete: (ref: { id: string }) => tx.deletes.push(ref.id),
      }),
  };
  return { db: db as never, tx };
}

describe('createFirestoreTokenStore().save — ADR 0011 tier 2, update-if-newer', () => {
  it('writes when nothing is stored yet', async () => {
    const { db, tx } = fakeDb({});
    const store = createFirestoreTokenStore(db, 'int-1');

    const out = await store.save(tok({ access_token: 'first' }));

    expect(out.access_token).toBe('first');
    expect(tx.sets.map((s) => s.id)).toEqual(['current']);
  });

  it('writes when the incoming token is strictly newer than the stored one', async () => {
    const { db, tx } = fakeDb({ current: tok({ access_token: 'old', expirationDate: NOW }) });
    const store = createFirestoreTokenStore(db, 'int-1');

    const out = await store.save(tok({ access_token: 'new', expirationDate: NOW + 1 }));

    expect(out.access_token).toBe('new');
    expect(tx.sets).toHaveLength(1);
  });

  /**
   * The #966 hazard. Two refreshes that both succeed are NOT ordered by
   * Firestore, and an OCC retry re-applies the callback's captured value
   * verbatim — so without this the later writer silently overwrites a newer
   * credential, and the operator ends up holding a refresh token that was
   * already rotated away.
   */
  it("drops an OLDER token and hands back the winner's instead", async () => {
    const winner = tok({
      access_token: 'winner',
      refresh_token: 'winnerR',
      expirationDate: NOW + 10_000,
    });
    const { db, tx } = fakeDb({ current: winner });
    const store = createFirestoreTokenStore(db, 'int-1');

    const out = await store.save(tok({ access_token: 'loser', expirationDate: NOW + 5_000 }));

    expect(tx.sets).toHaveLength(0); // nothing written
    expect(out.access_token).toBe('winner');
    // ⚠️ The whole PAIR comes back, not just the access token — a caller that
    // kept the loser's refresh_token would rotate against a dead grant next time.
    expect(out.refresh_token).toBe('winnerR');
    expect(out.expirationDate).toBe(NOW + 10_000);
  });

  it('treats an equal expirationDate as not-newer (a replayed save writes nothing)', async () => {
    const stored = tok({ access_token: 'stored', expirationDate: NOW + 10_000 });
    const { db, tx } = fakeDb({ current: stored });
    const store = createFirestoreTokenStore(db, 'int-1');

    const out = await store.save(tok({ access_token: 'same-age', expirationDate: NOW + 10_000 }));

    expect(tx.sets).toHaveLength(0);
    expect(out.access_token).toBe('stored');
  });

  /**
   * ADR 0011's "wrong-way default": the legacy corpus stores tokens under
   * arbitrary ids, and one carrying a bogus far-future `expirationDate` would
   * make a guard that compares against the whole lineage reject EVERY write
   * forever. The comparison is against `current` only — exactly the shape that
   * made the legacy ML shipment guard reject everything.
   */
  it('ignores a stray doc with a far-future expirationDate', async () => {
    const { db, tx } = fakeDb({
      'legacy-auto-id': tok({ access_token: 'bogus', expirationDate: NOW + 10 ** 12 }),
    });
    const store = createFirestoreTokenStore(db, 'int-1');

    const out = await store.save(tok({ access_token: 'real' }));

    expect(out.access_token).toBe('real');
    expect(tx.sets.map((s) => s.id)).toEqual(['current']);
  });

  it('lets the write through when the stored expirationDate is not a finite number', async () => {
    // ⚠️ `parseRead` is SOFT — it logs and returns the RAW document on a schema
    // mismatch, so a legacy or hand-edited `current` can hand the guard a
    // string, a null, or nothing at all. None of those may freeze the account's
    // token forever; the guard steps aside and the write heals the document.
    for (const bogus of [undefined, null, 'nao-e-numero', Number.NaN, Infinity]) {
      const { db, tx } = fakeDb({
        current: { access_token: 'x', refresh_token: 'y', expirationDate: bogus } as never,
      });
      const store = createFirestoreTokenStore(db, 'int-1');

      const out = await store.save(tok({ access_token: 'healed' }));

      expect(
        tx.sets.map((x) => x.id),
        String(bogus),
      ).toEqual(['current']);
      expect(out.access_token, String(bogus)).toBe('healed');
    }
  });

  it('collapses the legacy lineage in BOTH branches', async () => {
    // Single-token semantics do not depend on the write landing — a dropped
    // write is still an opportunity to prune the strays.
    for (const [label, incoming] of [
      ['write branch', tok({ expirationDate: NOW + 20_000 })],
      ['drop branch', tok({ expirationDate: NOW + 1_000 })],
    ] as const) {
      const { db, tx } = fakeDb({
        current: tok({ expirationDate: NOW + 10_000 }),
        'legacy-a': tok({ expirationDate: NOW }),
        'legacy-b': tok({ expirationDate: NOW }),
      });
      const store = createFirestoreTokenStore(db, 'int-1');

      await store.save(incoming);

      expect(tx.deletes.sort(), label).toEqual(['legacy-a', 'legacy-b']);
      expect(tx.deletes, label).not.toContain('current');
    }
  });

  it('force writes unconditionally — the OAuth callback path', async () => {
    // A human just re-consented. Their credential wins whatever is stored, even
    // a stored token that happens to outlive it.
    const { db, tx } = fakeDb({
      current: tok({ access_token: 'stored', expirationDate: NOW + 10 ** 9 }),
    });
    const store = createFirestoreTokenStore(db, 'int-1');

    const out = await store.save(tok({ access_token: 'reconnected' }), { force: true });

    expect(tx.sets).toHaveLength(1);
    expect(out.access_token).toBe('reconnected');
  });

  it('parses through the schema handle before writing', async () => {
    const { db, tx } = fakeDb({});
    const store = createFirestoreTokenStore(db, 'int-1');

    await store.save(tok());

    expect(h.parse).toHaveBeenCalledTimes(1);
    expect(tx.sets[0]?.data).toMatchObject({ __parsed: true });
  });
});
