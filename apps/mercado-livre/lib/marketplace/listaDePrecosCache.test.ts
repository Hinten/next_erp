import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  READ_CACHE_DISABLED_ENV,
  READ_CACHE_TTL,
  __resetAllReadCaches,
} from '@delfrance/data/admin/cache';
import { listaDePrecosCollection } from '@delfrance/data/admin/collections';

import { __setListaDePrecosCacheClockForTests, readListaDePrecos } from './listaDePrecosCache';

/**
 * Minimal Firestore double: `collection(path).doc(id).get()` plus a read log.
 * Mirrors `contaCache.test.ts` — the cached reader only ever calls
 * `docRef(db, ctx, id).get()`.
 */
type DocData = Record<string, unknown>;

class FakeDb {
  readonly reads: string[] = [];
  private readonly store = new Map<string, DocData>();

  seed(path: string, data: DocData): void {
    this.store.set(path, data);
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

const LISTA_PATH = listaDePrecosCollection.resolvePath({});
const LISTA_1_PATH = `${LISTA_PATH}/lista-1`;

function listaDoc(over: DocData = {}): DocData {
  return { nome: 'Tabela Padrão', padrao: true, ativo: true, ...over };
}

let now = 1_700_000_000_000;

beforeEach(() => {
  __resetAllReadCaches();
  now = 1_700_000_000_000;
  __setListaDePrecosCacheClockForTests(() => now);
  vi.stubEnv(READ_CACHE_DISABLED_ENV, '');
});

afterEach(() => {
  __resetAllReadCaches();
  __setListaDePrecosCacheClockForTests();
  vi.unstubAllEnvs();
});

describe('readListaDePrecos', () => {
  it('serves a repeated read from cache', async () => {
    const db = new FakeDb();
    db.seed(LISTA_1_PATH, listaDoc());

    await readListaDePrecos(asDb(db), 'lista-1');
    await readListaDePrecos(asDb(db), 'lista-1');

    expect(db.reads).toEqual([LISTA_1_PATH]);
  });

  it('re-reads after ttlMs — the staleness contract, not just the hit', async () => {
    const db = new FakeDb();
    db.seed(LISTA_1_PATH, listaDoc());

    await readListaDePrecos(asDb(db), 'lista-1');
    now += READ_CACHE_TTL.config - 1;
    await readListaDePrecos(asDb(db), 'lista-1');
    expect(db.reads).toHaveLength(1);

    // The boundary is EXCLUSIVE: at exactly `ttlMs` the entry is expired.
    now += 1;
    await readListaDePrecos(asDb(db), 'lista-1');
    expect(db.reads).toHaveLength(2);
  });

  it('collapses concurrent reads into one (single-flight)', async () => {
    const db = new FakeDb();
    db.seed(LISTA_1_PATH, listaDoc());

    await Promise.all(Array.from({ length: 5 }, () => readListaDePrecos(asDb(db), 'lista-1')));

    expect(db.reads).toEqual([LISTA_1_PATH]);
  });

  it('resolves null for a table that does not exist — the fallback-message case', async () => {
    const db = new FakeDb();

    expect(await readListaDePrecos(asDb(db), 'does-not-exist')).toBeNull();
  });

  it('keys per price list — one table never serves another', async () => {
    const db = new FakeDb();
    db.seed(LISTA_1_PATH, listaDoc({ nome: 'Tabela Padrão' }));
    db.seed(`${LISTA_PATH}/lista-2`, listaDoc({ nome: 'Tabela Promocional' }));

    expect((await readListaDePrecos(asDb(db), 'lista-1'))?.nome).toBe('Tabela Padrão');
    expect((await readListaDePrecos(asDb(db), 'lista-2'))?.nome).toBe('Tabela Promocional');
  });

  it('passes through when the kill switch is set', async () => {
    vi.stubEnv(READ_CACHE_DISABLED_ENV, '1');
    const db = new FakeDb();
    db.seed(LISTA_1_PATH, listaDoc());

    await readListaDePrecos(asDb(db), 'lista-1');
    await readListaDePrecos(asDb(db), 'lista-1');

    expect(db.reads).toHaveLength(2);
  });
});
