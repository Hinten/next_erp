import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import { OccEngine, type OccTransaction } from '../../testing/occTransaction';
import { oauthStateIntFreteCollection, oauthStateCollection } from '../collections';
import { createOauthStateStore } from './store';
import { MAX_AGE_MS, OauthStateError } from './state';

type Doc = Record<string, unknown>;

function makeDb() {
  const docs = new Map<string, Doc>();
  const occ = new OccEngine({
    applyWrite: (kind, path, patch, precondition) => {
      if (kind !== 'update' || precondition) {
        throw new Error(`unsupported transactional write: ${kind} on ${path}`);
      }
      const current = docs.get(path);
      if (!current) throw Object.assign(new Error(`update on missing doc ${path}`), { code: 5 });
      docs.set(path, { ...current, ...patch });
    },
  });
  const refFor = (path: string) => ({
    path,
    get: async () => {
      const data = docs.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: Doc, options?: { merge: boolean }) => {
      docs.set(path, options?.merge ? { ...docs.get(path), ...data } : { ...data });
    },
  });
  const db = {
    collection: (collPath: string) => ({ doc: (id: string) => refFor(`${collPath}/${id}`) }),
    runTransaction: <T>(fn: (tx: OccTransaction) => Promise<T>) => occ.runTransaction(fn),
  };
  return { db: db as unknown as Firestore, docs, occ };
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

  it('fully replaces a consumed attempt, including fields omitted by the new attempt', async () => {
    const { db, docs } = makeDb();
    await store.put(db, 'int-1', { nonce: 'n1', codeVerifier: 'v1' }, NOW);
    await store.consume(db, 'int-1', 'n1', NOW);
    expect(docs.get(PATH)).toMatchObject({ consumidoEm: NOW });
    docs.set(PATH, { ...docs.get(PATH), legacyField: true });

    await store.put(db, 'int-1', { nonce: 'n2', codeVerifier: 'v2' }, NOW + 1);
    expect(docs.get(PATH)).toMatchObject({ consumidoEm: null });
    expect(docs.get(PATH)).not.toHaveProperty('legacyField');
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

  it('lets one racing callback redeem the nonce and rejects the other on retry', async () => {
    const { db, docs, occ } = makeDb();
    await store.put(db, 'int-1', { nonce: 'n1', codeVerifier: 'v1' }, NOW);
    const firstStamp = NOW + 1;
    const secondStamp = NOW + 2;

    occ.beforeCommit = async ({ attempt, writes }) => {
      if (attempt === 1 && writes.some(({ data }) => data.consumidoEm === firstStamp)) {
        // Let the second callback commit while the first has a buffered write.
        await expect(store.consume(db, 'int-1', 'n1', secondStamp)).resolves.toEqual({
          codeVerifier: 'v1',
        });
      }
    };

    const first = store.consume(db, 'int-1', 'n1', firstStamp);
    await expect(first).rejects.toThrow(OauthStateError);
    await expect(first).rejects.toThrow('state já utilizado');

    expect(occ.txLog).toEqual([
      { label: 'tx1', attempt: 1, phase: 'begin' },
      { label: 'tx2', attempt: 1, phase: 'begin' },
      { label: 'tx2', attempt: 1, phase: 'commit' },
      { label: 'tx1', attempt: 1, phase: 'abort', conflictPath: PATH },
      { label: 'tx1', attempt: 2, phase: 'begin' },
    ]);
    expect(docs.get(PATH)).toMatchObject({ consumidoEm: secondStamp });
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
