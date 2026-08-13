import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  READ_CACHE_DISABLED_ENV,
  READ_CACHE_TTL,
  __resetAllReadCaches,
} from '@delfrance/data/admin/cache';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import {
  __setContaCacheClockForTests,
  invalidateConta,
  readConta,
  readIntFreteOuterRefDaConta,
  resolveContaAtivaPorUserId,
} from './contaCache';

/**
 * Minimal Firestore double: `collection(path).doc(id).get()` plus a read log.
 * Modelled on `packages/data/src/admin/cache/cachedDocReader.test.ts` — the
 * cached reader only ever calls `docRef(db, ctx, id).get()`.
 */
type DocData = Record<string, unknown>;

class FakeDb {
  readonly reads: string[] = [];
  private readonly store = new Map<string, DocData>();

  seed(path: string, data: DocData): void {
    this.store.set(path, data);
  }

  remove(path: string): void {
    this.store.delete(path);
  }

  collection(path: string) {
    return {
      doc: (id: string) => {
        const full = `${path}/${id}`;
        return {
          path: full,
          get: async (): Promise<{ exists: boolean; data: () => DocData | undefined }> => {
            this.reads.push(full);
            const data = this.store.get(full);
            return { exists: data !== undefined, data: () => data };
          },
        };
      },
    };
  }
}

const asDb = (db: FakeDb): Firestore => db as unknown as Firestore;

const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const CONTA_PATH = `${INTEGRACAO_PATH}/conta-A`;

function contaDoc(over: DocData = {}): DocData {
  return {
    tipo: INTEGRACAO_TIPO.mercadoLivre,
    ativo: true,
    nome: 'Conta A',
    user_id: 55,
    ...over,
  };
}

/** A `load` that records how often the (uncached) query would have run. */
function countingResolve(result: string | null) {
  const calls: number[] = [];
  return {
    calls,
    load: async (): Promise<string | null> => {
      calls.push(1);
      return result;
    },
  };
}

let now = 1_700_000_000_000;

beforeEach(() => {
  __resetAllReadCaches();
  now = 1_700_000_000_000;
  __setContaCacheClockForTests(() => now);
  vi.stubEnv(READ_CACHE_DISABLED_ENV, '');
});

afterEach(() => {
  __resetAllReadCaches();
  __setContaCacheClockForTests();
  vi.unstubAllEnvs();
});

describe('readConta', () => {
  it('serves a repeated read from cache', async () => {
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());

    await readConta(asDb(db), 'conta-A');
    await readConta(asDb(db), 'conta-A');

    expect(db.reads).toEqual([CONTA_PATH]);
  });

  it('re-reads after ttlMs — the staleness contract, not just the hit', async () => {
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());

    await readConta(asDb(db), 'conta-A');
    now += READ_CACHE_TTL.config - 1;
    await readConta(asDb(db), 'conta-A');
    expect(db.reads).toHaveLength(1);

    // The boundary is EXCLUSIVE: at exactly `ttlMs` the entry is expired.
    now += 1;
    await readConta(asDb(db), 'conta-A');
    expect(db.reads).toHaveLength(2);
  });

  it('collapses concurrent reads into one (single-flight — the stock-send burst)', async () => {
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());

    await Promise.all(Array.from({ length: 5 }, () => readConta(asDb(db), 'conta-A')));

    expect(db.reads).toEqual([CONTA_PATH]);
  });

  it('refuses a cached conta with no user_id on every hit (isFresh)', async () => {
    // A never-connected account is back-filled by `exchangeAndPersist` on a
    // DIFFERENT instance, so a pre-OAuth document must never be served warm.
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc({ user_id: null }));

    await readConta(asDb(db), 'conta-A');
    await readConta(asDb(db), 'conta-A');
    expect(db.reads).toHaveLength(2); // every hit is refused and re-read

    // Once OAuth back-fills `user_id`, the very next hit is the one that picks
    // it up (evict + re-read), and from then on the entry is served warm.
    db.seed(CONTA_PATH, contaDoc({ user_id: 55 }));
    expect((await readConta(asDb(db), 'conta-A'))?.user_id).toBe(55);
    expect(db.reads).toHaveLength(3);
    await readConta(asDb(db), 'conta-A');
    expect(db.reads).toHaveLength(3);
  });

  it('invalidateConta drops the entry (the exchangeAndPersist obligation)', async () => {
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());

    await readConta(asDb(db), 'conta-A');
    invalidateConta('conta-A');
    await readConta(asDb(db), 'conta-A');

    expect(db.reads).toHaveLength(2); // no clock advance — the evict did it
  });

  it('passes through when the kill switch is set', async () => {
    vi.stubEnv(READ_CACHE_DISABLED_ENV, '1');
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());

    await readConta(asDb(db), 'conta-A');
    await readConta(asDb(db), 'conta-A');

    expect(db.reads).toHaveLength(2);
  });
});

describe('resolveContaAtivaPorUserId', () => {
  it('caches the resolved id and pre-warms the conta the runners read next', async () => {
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());
    const { calls, load } = countingResolve('conta-A');

    expect(await resolveContaAtivaPorUserId(asDb(db), 55, load)).toBe('conta-A');
    expect(await resolveContaAtivaPorUserId(asDb(db), 55, load)).toBe('conta-A');

    expect(calls).toHaveLength(1); // the three-predicate query ran once
    expect(db.reads).toEqual([CONTA_PATH]); // and the conta get is warm too
  });

  it('never caches "no account" — a cached absence manufactures failure rows', async () => {
    // `null` → { kind: 'no-account' } → { kind: 'defer' } (#808) → the DEFERRED
    // lane, re-driven once a DAY. A cached absence would also break the
    // connect-time `redriveDeferredForUserId` re-drive.
    const db = new FakeDb();
    const miss = countingResolve(null);

    expect(await resolveContaAtivaPorUserId(asDb(db), 55, miss.load)).toBeNull();
    expect(await resolveContaAtivaPorUserId(asDb(db), 55, miss.load)).toBeNull();
    expect(miss.calls).toHaveLength(2);

    // A seller who connects moments later resolves immediately — no clock move.
    db.seed(CONTA_PATH, contaDoc());
    const hit = countingResolve('conta-A');
    expect(await resolveContaAtivaPorUserId(asDb(db), 55, hit.load)).toBe('conta-A');
  });

  it('self-heals a reconnect to a DIFFERENT ML account', async () => {
    // Without this guard a stale `user_id` reaches the seller check in
    // `orderImport`, which returns `seller-mismatch` → the dispatcher acks
    // `done` → nothing is persisted → the sweep never re-drives it. The order
    // would be SILENTLY LOST for up to the TTL.
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc({ user_id: 55 }));
    await resolveContaAtivaPorUserId(asDb(db), 55, countingResolve('conta-A').load);

    // Another instance ran the OAuth callback: the doc now names account 77 and
    // notifications arrive for 77, but this instance's entries still say 55.
    db.seed(CONTA_PATH, contaDoc({ user_id: 77 }));
    const { calls, load } = countingResolve('conta-A');

    expect(await resolveContaAtivaPorUserId(asDb(db), 77, load)).toBe('conta-A');
    // …and the conta every runner reads next is the FRESH one.
    expect((await readConta(asDb(db), 'conta-A'))?.user_id).toBe(77);
    // Bounded: one eviction, one retry of the query, no loop.
    expect(calls).toHaveLength(2);
  });

  it('does not re-resolve when the cached conta agrees with the notification', async () => {
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc({ user_id: 55 }));
    const { calls, load } = countingResolve('conta-A');

    await resolveContaAtivaPorUserId(asDb(db), 55, load);
    await resolveContaAtivaPorUserId(asDb(db), 55, load);

    expect(calls).toHaveLength(1);
  });

  it('re-resolves rather than returning an id whose conta is gone', async () => {
    // A cached mapping can outlive its document — the conta entry can be dropped
    // by the LRU or by a delete landing between the query and the get, while the
    // id entry survives. Returning that id would be WORSE than not caching:
    // `loadMercadoLivreContext` throws `MercadoLivreContaNotConfiguredError`,
    // which the pipeline reads as retryable and eventually persists as a
    // failure, where the uncached query resolves `null` → `{ kind: 'no-account' }`
    // → the deferred lane. `resolveIntegracaoByUserId` queries the collection, so
    // it can never name a deleted doc — hence the re-run returns null here.
    const db = new FakeDb();
    const calls: number[] = [];
    const load = async (): Promise<string | null> => {
      calls.push(1);
      // The stale mapping first, then what a fresh query against the real
      // collection would find once the conta is gone.
      return calls.length === 1 ? 'conta-A' : null;
    };

    expect(await resolveContaAtivaPorUserId(asDb(db), 55, load)).toBeNull();
    // Bounded: one eviction, one retry of the query, no loop.
    expect(calls).toHaveLength(2);
  });

  it('does not cache the re-resolved absence — the seller may connect next second', async () => {
    const db = new FakeDb();
    const calls: number[] = [];
    const load = async (): Promise<string | null> => {
      calls.push(1);
      return calls.length === 1 ? 'conta-A' : null;
    };
    expect(await resolveContaAtivaPorUserId(asDb(db), 55, load)).toBeNull();

    // The seller reconnects; the very next notification must find them.
    db.seed(CONTA_PATH, contaDoc({ user_id: 55 }));
    const { load: reconnected } = countingResolve('conta-A');
    expect(await resolveContaAtivaPorUserId(asDb(db), 55, reconnected)).toBe('conta-A');
  });
});

describe('readIntFreteOuterRefDaConta', () => {
  it('resolves once across repeated shipments notifications', async () => {
    const { calls, load } = countingResolve('documents/int_frete/if-1');

    expect(await readIntFreteOuterRefDaConta('conta-A', load)).toBe('documents/int_frete/if-1');
    expect(await readIntFreteOuterRefDaConta('conta-A', load)).toBe('documents/int_frete/if-1');

    expect(calls).toHaveLength(1);
  });

  it('re-resolves after ttlMs', async () => {
    const { calls, load } = countingResolve('documents/int_frete/if-1');

    await readIntFreteOuterRefDaConta('conta-A', load);
    now += READ_CACHE_TTL.config;
    await readIntFreteOuterRefDaConta('conta-A', load);

    expect(calls).toHaveLength(2);
  });

  it('never caches a null — it would be PERSISTED onto a first-import pedido', async () => {
    // `mergeFreteInicial` has no `existing` to fall back on for a first import,
    // so a stale null lands as `integracaoFreteOuterRef: null` on the pedido and
    // the etiqueta row action can no longer classify it.
    const miss = countingResolve(null);

    expect(await readIntFreteOuterRefDaConta('conta-A', miss.load)).toBeNull();
    expect(await readIntFreteOuterRefDaConta('conta-A', miss.load)).toBeNull();
    expect(miss.calls).toHaveLength(2);

    // The companion doc the #782 trigger writes is picked up immediately.
    const hit = countingResolve('documents/int_frete/if-1');
    expect(await readIntFreteOuterRefDaConta('conta-A', hit.load)).toBe('documents/int_frete/if-1');
  });

  it('keys per conta — one account never serves another', async () => {
    const a = countingResolve('documents/int_frete/if-a');
    const b = countingResolve('documents/int_frete/if-b');

    expect(await readIntFreteOuterRefDaConta('conta-A', a.load)).toBe('documents/int_frete/if-a');
    expect(await readIntFreteOuterRefDaConta('conta-B', b.load)).toBe('documents/int_frete/if-b');

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });
});
