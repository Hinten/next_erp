import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import { oauthStateIntFreteCollection, oauthStateCollection } from '../collections';
import { createOauthStateStore } from './store';
import { MAX_AGE_MS, OauthStateError } from './state';

/**
 * In-memory Firestore stand-in. Deliberately NOT a mock of the store's own reads:
 * the behaviour under test IS the read-check-stamp sequence, so the documents
 * have to actually persist between calls for a replay to be a replay.
 */
function makeDb(): { db: Firestore; docs: Map<string, Record<string, unknown>> } {
  const docs = new Map<string, Record<string, unknown>>();
  const refFor = (path: string) => ({
    path,
    set: async (data: Record<string, unknown>) => {
      docs.set(path, data);
    },
  });
  const db = {
    collection: (collPath: string) => ({ doc: (id: string) => refFor(`${collPath}/${id}`) }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        get: async (ref: { path: string }) => {
          const data = docs.get(ref.path);
          return { exists: data !== undefined, data: () => data };
        },
        update: (ref: { path: string }, patch: Record<string, unknown>) => {
          const current = docs.get(ref.path);
          if (!current) throw new Error(`update on missing doc ${ref.path}`);
          docs.set(ref.path, { ...current, ...patch });
        },
      }),
  };
  return { db: db as unknown as Firestore, docs };
}

const store = createOauthStateStore(oauthStateCollection, 'integracaoId');
const PATH = 'integracao/int-1/oauthState/current';
const NOW = 1_700_000_000_000;

describe('put', () => {
  it('writes the attempt at a fixed doc id, unconsumed', async () => {
    const { db, docs } = makeDb();
    await store.put(db, 'int-1', { nonce: 'n1', codeVerifier: 'v1' }, NOW);

    expect(docs.get(PATH)).toEqual({
      nonce: 'n1',
      codeVerifier: 'v1',
      criadoEm: NOW,
      consumidoEm: null,
    });
  });

  it('keeps at most one attempt per account', async () => {
    const { db, docs } = makeDb();
    await store.put(db, 'int-1', { nonce: 'n1', codeVerifier: 'v1' }, NOW);
    await store.put(db, 'int-2', { nonce: 'n2', codeVerifier: 'v2' }, NOW);
    await store.put(db, 'int-1', { nonce: 'n3', codeVerifier: 'v3' }, NOW);

    expect(docs.size).toBe(2);
    expect(docs.get(PATH)).toMatchObject({ nonce: 'n3' });
  });

  it('FULLY overwrites — a consumed predecessor cannot poison the new attempt', async () => {
    // With a merge instead of a set, the previous `consumidoEm` would survive and
    // the fresh attempt would be born already redeemed, breaking every connect
    // rather than just the replays.
    const { db, docs } = makeDb();
    await store.put(db, 'int-1', { nonce: 'n1', codeVerifier: 'v1' }, NOW);
    await store.consume(db, 'int-1', 'n1', NOW);
    expect(docs.get(PATH)).toMatchObject({ consumidoEm: NOW });

    await store.put(db, 'int-1', { nonce: 'n2', codeVerifier: 'v2' }, NOW + 1);
    expect(docs.get(PATH)).toMatchObject({ consumidoEm: null });
    await expect(store.consume(db, 'int-1', 'n2', NOW + 2)).resolves.toEqual({
      codeVerifier: 'v2',
    });
  });
});

describe('consume', () => {
  it('returns the stored verifier and stamps the attempt consumed', async () => {
    const { db, docs } = makeDb();
    await store.put(db, 'int-1', { nonce: 'n1', codeVerifier: 'v1' }, NOW);

    await expect(store.consume(db, 'int-1', 'n1', NOW + 1_000)).resolves.toEqual({
      codeVerifier: 'v1',
    });
    expect(docs.get(PATH)).toMatchObject({ consumidoEm: NOW + 1_000 });
  });

  it('REJECTS a second redemption of the same nonce — the replay #821/#1034 is about', async () => {
    const { db } = makeDb();
    await store.put(db, 'int-1', { nonce: 'n1', codeVerifier: 'v1' }, NOW);

    await store.consume(db, 'int-1', 'n1', NOW + 1);
    await expect(store.consume(db, 'int-1', 'n1', NOW + 2)).rejects.toThrow(OauthStateError);
  });

  it('rejects a nonce superseded by a newer attempt', async () => {
    // A captured state from an abandoned "Conectar" must not redeem the attempt
    // a later click started.
    const { db } = makeDb();
    await store.put(db, 'int-1', { nonce: 'old', codeVerifier: 'v1' }, NOW);
    await store.put(db, 'int-1', { nonce: 'new', codeVerifier: 'v2' }, NOW + 1);

    await expect(store.consume(db, 'int-1', 'old', NOW + 2)).rejects.toThrow(OauthStateError);
    // The current attempt is untouched by the rejected one.
    await expect(store.consume(db, 'int-1', 'new', NOW + 3)).resolves.toEqual({
      codeVerifier: 'v2',
    });
  });

  it('rejects an attempt older than the state freshness window', async () => {
    const { db } = makeDb();
    await store.put(db, 'int-1', { nonce: 'n1', codeVerifier: 'v1' }, NOW);

    await expect(store.consume(db, 'int-1', 'n1', NOW + MAX_AGE_MS + 1)).rejects.toThrow(
      OauthStateError,
    );
    // Right at the boundary it is still good.
    const fresh = makeDb();
    await store.put(fresh.db, 'int-1', { nonce: 'n1', codeVerifier: 'v1' }, NOW);
    await expect(store.consume(fresh.db, 'int-1', 'n1', NOW + MAX_AGE_MS)).resolves.toBeTruthy();
  });

  it('rejects when no attempt was ever recorded', async () => {
    const { db } = makeDb();
    await expect(store.consume(db, 'int-1', 'n1', NOW)).rejects.toThrow(OauthStateError);
  });

  it('does not leak one account attempt to another', async () => {
    const { db } = makeDb();
    await store.put(db, 'int-1', { nonce: 'n1', codeVerifier: 'v1' }, NOW);
    await expect(store.consume(db, 'int-2', 'n1', NOW)).rejects.toThrow(OauthStateError);
  });

  it('carries a null verifier through when PKCE was off', async () => {
    const { db } = makeDb();
    await store.put(db, 'int-1', { nonce: 'n1', codeVerifier: null }, NOW);
    await expect(store.consume(db, 'int-1', 'n1', NOW)).resolves.toEqual({ codeVerifier: null });
  });
});

describe('per-channel binding', () => {
  it('writes under the bound channel path, keyed by its own placeholder', async () => {
    // The three channels share this store but must never share a document —
    // `pathKey` is what routes each one to its own subcollection.
    const { db, docs } = makeDb();
    const freight = createOauthStateStore(oauthStateIntFreteCollection, 'intFreteId');

    await freight.put(db, 'frete-1', { nonce: 'n1', codeVerifier: null }, NOW);

    expect([...docs.keys()]).toEqual(['int_frete/frete-1/oauthState/current']);
    await expect(freight.consume(db, 'frete-1', 'n1', NOW)).resolves.toEqual({
      codeVerifier: null,
    });
  });

  it('keeps channels isolated — one channel cannot redeem another channel attempt', async () => {
    const { db } = makeDb();
    const freight = createOauthStateStore(oauthStateIntFreteCollection, 'intFreteId');

    await store.put(db, 'same-id', { nonce: 'shared-nonce', codeVerifier: null }, NOW);
    await expect(freight.consume(db, 'same-id', 'shared-nonce', NOW)).rejects.toThrow(
      OauthStateError,
    );
  });
});
