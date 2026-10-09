import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { READ_CACHE_TTL, __resetAllReadCaches } from '@delfrance/data/admin/cache';

import { FakeDb, asDb } from '../testing/fakeDb';
import { AGORA_MS, caminhoConta, seedConta } from '../testing/fixtures';
import {
  __setRelogioDoCacheParaTestes,
  invalidarContaEmCache,
  lerContaEmCache,
} from './contaCache';

const ID = 'conta-li-1';
let agora = AGORA_MS;

beforeEach(() => {
  __resetAllReadCaches();
  agora = AGORA_MS;
  __setRelogioDoCacheParaTestes(() => agora);
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
});

function leiturasDaConta(db: FakeDb): number {
  return db.leituras.filter((p) => p === caminhoConta(ID)).length;
}

describe('lerContaEmCache', () => {
  it('an ACTIVE conta is served from cache until the 15-minute TTL', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    await lerContaEmCache(asDb(db), ID);
    agora += READ_CACHE_TTL.config - 1;
    await lerContaEmCache(asDb(db), ID);
    expect(leiturasDaConta(db)).toBe(1);
    agora += 2;
    await lerContaEmCache(asDb(db), ID);
    expect(leiturasDaConta(db)).toBe(2);
    expect(READ_CACHE_TTL.config).toBe(15 * 60 * 1000);
  });

  it('near-miss: an INACTIVE conta is re-read every time (isFresh), so a reactivation is immediate', async () => {
    const db = new FakeDb();
    seedConta(db, ID, { ativo: false });
    await lerContaEmCache(asDb(db), ID);
    await lerContaEmCache(asDb(db), ID);
    expect(leiturasDaConta(db)).toBe(2);
    seedConta(db, ID, { ativo: true });
    expect((await lerContaEmCache(asDb(db), ID))?.ativo).toBe(true);
  });

  it('absence is never cached: a conta created a second later is found by the next read', async () => {
    const db = new FakeDb();
    expect(await lerContaEmCache(asDb(db), ID)).toBeNull();
    seedConta(db, ID);
    expect(await lerContaEmCache(asDb(db), ID)).not.toBeNull();
    expect(leiturasDaConta(db)).toBe(2);
  });

  it('invalidarContaEmCache drops the entry on this instance', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    await lerContaEmCache(asDb(db), ID);
    invalidarContaEmCache(ID);
    await lerContaEmCache(asDb(db), ID);
    expect(leiturasDaConta(db)).toBe(2);
  });

  it('reads the conta document only — never the credential', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    await lerContaEmCache(asDb(db), ID);
    expect(db.leituras).toEqual([caminhoConta(ID)]);
  });
});
