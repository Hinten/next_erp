import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defineAdminCollection } from '../defineAdminCollection';
import { createCachedDocReader } from './cachedDocReader';
import { READ_CACHE_DISABLED_ENV, READ_CACHE_TTL, __resetAllReadCaches } from './readCache';

type DocData = Record<string, unknown>;

/**
 * Minimal admin-Firestore stand-in: only `collection(path).doc(id).get()`, plus a
 * `reads` log so "one read per TTL window" is assertable. Cast at the boundary,
 * the convention used by `notifications/pipeline.test.ts`.
 */
class FakeDb {
  readonly reads: string[] = [];
  private readonly docs = new Map<string, DocData>();

  seed(path: string, data: DocData): void {
    this.docs.set(path, data);
  }

  collection(path: string) {
    return {
      doc: (id: string) => {
        const full = `${path}/${id}`;
        return {
          path: full,
          get: async (): Promise<{ exists: boolean; data: () => DocData | undefined }> => {
            this.reads.push(full);
            const data = this.docs.get(full);
            return { exists: data !== undefined, data: () => data };
          },
        };
      },
    };
  }
}

const asDb = (db: FakeDb): Firestore => db as unknown as Firestore;

const contaSchema = z.object({
  tipo: z.string(),
  user_id: z.number().nullable().default(null),
});
const contaCollection = defineAdminCollection({ path: 'integracao', schema: contaSchema });

const configSchema = z.object({ ambiente: z.string() });
const configCollection = defineAdminCollection({
  path: 'filial/{filialId}/nfeconfig',
  schema: configSchema,
});

function makeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: (): number => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

let db: FakeDb;
let clock: ReturnType<typeof makeClock>;

beforeEach(() => {
  db = new FakeDb();
  clock = makeClock();
  __resetAllReadCaches();
  vi.stubEnv(READ_CACHE_DISABLED_ENV, '');
});

afterEach(() => {
  __resetAllReadCaches();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createCachedDocReader', () => {
  it('reads once per TTL window and re-reads after it', async () => {
    db.seed('integracao/i1', { tipo: 'mercadoLivre', user_id: 7 });
    const reader = createCachedDocReader(contaCollection, {
      name: 'test:integracao',
      ttlMs: READ_CACHE_TTL.config,
      maxEntries: 8,
      now: clock.now,
    });

    expect(await reader.get(asDb(db), {}, 'i1')).toEqual({ tipo: 'mercadoLivre', user_id: 7 });
    expect(await reader.get(asDb(db), {}, 'i1')).toEqual({ tipo: 'mercadoLivre', user_id: 7 });
    expect(db.reads).toEqual(['integracao/i1']);

    clock.advance(READ_CACHE_TTL.config);
    await reader.get(asDb(db), {}, 'i1');
    expect(db.reads).toEqual(['integracao/i1', 'integracao/i1']);
  });

  it('parses through the schema — defaults are applied, not the raw document', async () => {
    db.seed('integracao/i1', { tipo: 'whatsapp' }); // user_id absent
    const reader = createCachedDocReader(contaCollection, {
      name: 'test:parse',
      ttlMs: 60_000,
      maxEntries: 8,
      now: clock.now,
    });

    expect(await reader.get(asDb(db), {}, 'i1')).toEqual({ tipo: 'whatsapp', user_id: null });
  });

  it('labels a soft-read mismatch with the concrete document path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db.seed('integracao/i1', { tipo: 42 }); // wrong type
    const reader = createCachedDocReader(contaCollection, {
      name: 'test:softread',
      ttlMs: 60_000,
      maxEntries: 8,
      now: clock.now,
    });

    await reader.get(asDb(db), {}, 'i1');
    expect(warn.mock.calls[0]?.[0]).toBe('[data] schema mismatch on integracao/i1');
  });

  it('keys by the resolved doc path, so a subcollection context namespaces entries', async () => {
    db.seed('filial/f1/nfeconfig/default', { ambiente: 'homologacao' });
    db.seed('filial/f2/nfeconfig/default', { ambiente: 'producao' });
    const reader = createCachedDocReader(configCollection, {
      name: 'test:nfeconfig',
      ttlMs: 60_000,
      maxEntries: 8,
      now: clock.now,
    });

    expect(await reader.get(asDb(db), { filialId: 'f1' }, 'default')).toEqual({
      ambiente: 'homologacao',
    });
    expect(await reader.get(asDb(db), { filialId: 'f2' }, 'default')).toEqual({
      ambiente: 'producao',
    });
    expect(await reader.get(asDb(db), { filialId: 'f1' }, 'default')).toEqual({
      ambiente: 'homologacao',
    });

    expect(db.reads).toEqual(['filial/f1/nfeconfig/default', 'filial/f2/nfeconfig/default']);
    expect(reader.stats()).toMatchObject({ hits: 1, misses: 2, size: 2 });
  });

  it('caches absence under the negative window, so a later create still appears', async () => {
    const reader = createCachedDocReader(contaCollection, {
      name: 'test:absent',
      ttlMs: READ_CACHE_TTL.config,
      maxEntries: 8,
      negativeTtlMs: READ_CACHE_TTL.negative,
      now: clock.now,
    });

    expect(await reader.get(asDb(db), {}, 'i1')).toBeNull();
    expect(await reader.get(asDb(db), {}, 'i1')).toBeNull();
    expect(db.reads).toHaveLength(1);

    db.seed('integracao/i1', { tipo: 'mercadoLivre', user_id: 7 });
    clock.advance(READ_CACHE_TTL.negative);
    expect(await reader.get(asDb(db), {}, 'i1')).toMatchObject({ user_id: 7 });
    expect(db.reads).toHaveLength(2);
  });

  it('never runs isFresh against a cached absence', async () => {
    const isFresh = vi.fn((conta: z.infer<typeof contaSchema>) => conta.user_id != null);
    const reader = createCachedDocReader(contaCollection, {
      name: 'test:fresh-absent',
      ttlMs: 60_000,
      maxEntries: 8,
      negativeTtlMs: 5_000,
      isFresh,
      now: clock.now,
    });

    expect(await reader.get(asDb(db), {}, 'i1')).toBeNull();
    expect(await reader.get(asDb(db), {}, 'i1')).toBeNull();
    expect(isFresh).not.toHaveBeenCalled();
    expect(db.reads).toHaveLength(1);
  });

  it('isFresh refuses a document that predates a connect-time back-fill', async () => {
    db.seed('integracao/i1', { tipo: 'mercadoLivre', user_id: null });
    const reader = createCachedDocReader(contaCollection, {
      name: 'test:fresh',
      ttlMs: READ_CACHE_TTL.config,
      maxEntries: 8,
      isFresh: (conta) => conta.user_id != null,
      now: clock.now,
    });

    await reader.get(asDb(db), {}, 'i1');
    await reader.get(asDb(db), {}, 'i1');
    expect(db.reads).toHaveLength(2); // refused, so re-read within the TTL

    db.seed('integracao/i1', { tipo: 'mercadoLivre', user_id: 7 });
    expect(await reader.get(asDb(db), {}, 'i1')).toMatchObject({ user_id: 7 });
    await reader.get(asDb(db), {}, 'i1');
    expect(db.reads).toHaveLength(3); // now it passes and hits
  });

  it('invalidate forces the next get to re-read — the self-write path', async () => {
    db.seed('integracao/i1', { tipo: 'mercadoLivre', user_id: null });
    const reader = createCachedDocReader(contaCollection, {
      name: 'test:invalidate',
      ttlMs: READ_CACHE_TTL.config,
      maxEntries: 8,
      now: clock.now,
    });

    await reader.get(asDb(db), {}, 'i1');
    // …the process merges `user_id` onto the very document it just read…
    db.seed('integracao/i1', { tipo: 'mercadoLivre', user_id: 7 });
    reader.invalidate({}, 'i1');

    expect(await reader.get(asDb(db), {}, 'i1')).toMatchObject({ user_id: 7 });
    expect(db.reads).toHaveLength(2);
  });

  it('dedups concurrent reads of the same document into one get', async () => {
    db.seed('integracao/i1', { tipo: 'mercadoLivre', user_id: 7 });
    const reader = createCachedDocReader(contaCollection, {
      name: 'test:single-flight',
      ttlMs: 60_000,
      maxEntries: 8,
      now: clock.now,
    });

    const all = await Promise.all(Array.from({ length: 5 }, () => reader.get(asDb(db), {}, 'i1')));
    expect(db.reads).toEqual(['integracao/i1']);
    expect(new Set(all).size).toBe(1); // one shared object reference
  });

  it('clear drops the entries and stats reports through to the cache', async () => {
    db.seed('integracao/i1', { tipo: 'mercadoLivre', user_id: 7 });
    const reader = createCachedDocReader(contaCollection, {
      name: 'test:clear',
      ttlMs: 60_000,
      maxEntries: 8,
      now: clock.now,
    });

    await reader.get(asDb(db), {}, 'i1');
    await reader.get(asDb(db), {}, 'i1');
    expect(reader.stats()).toMatchObject({ name: 'test:clear', hits: 1, misses: 1, size: 1 });

    reader.clear();
    expect(reader.stats()).toMatchObject({ size: 0 });
    await reader.get(asDb(db), {}, 'i1');
    expect(db.reads).toHaveLength(2);
  });

  it('is a passthrough under the kill switch', async () => {
    vi.stubEnv(READ_CACHE_DISABLED_ENV, '1');
    db.seed('integracao/i1', { tipo: 'mercadoLivre', user_id: 7 });
    const reader = createCachedDocReader(contaCollection, {
      name: 'test:killed',
      ttlMs: 60_000,
      maxEntries: 8,
      now: clock.now,
    });

    await reader.get(asDb(db), {}, 'i1');
    await reader.get(asDb(db), {}, 'i1');
    expect(db.reads).toHaveLength(2);
  });
});
