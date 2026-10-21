import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { READ_CACHE_TTL, __resetAllReadCaches } from '@delfrance/data/admin/cache';

import { FakeDb, asDb } from '../testing/fakeDb';
import { AGORA_MS, SPID_A, caminhoConta, seedConta } from '../testing/fixtures';
import {
  __setRelogioDoCacheParaTestes,
  invalidarContaEmCache,
  lerContaEmCache,
} from './contaCache';

let db: FakeDb;
let agora: number;

beforeEach(() => {
  __resetAllReadCaches();
  agora = AGORA_MS;
  __setRelogioDoCacheParaTestes(() => agora);
  db = new FakeDb();
});

afterEach(() => {
  __setRelogioDoCacheParaTestes();
  __resetAllReadCaches();
});

const leiturasDaConta = (id: string) => db.leituras.filter((p) => p === caminhoConta(id)).length;

describe('lerContaEmCache', () => {
  it('serves an active, connected conta from cache within the TTL', async () => {
    seedConta(db, 'c1', { selling_partner_id: SPID_A });
    await lerContaEmCache(asDb(db), 'c1');
    await lerContaEmCache(asDb(db), 'c1');
    expect(leiturasDaConta('c1')).toBe(1);
    agora += READ_CACHE_TTL.config + 1;
    await lerContaEmCache(asDb(db), 'c1');
    expect(leiturasDaConta('c1')).toBe(2);
  });

  it('never serves an INACTIVE conta from cache (a reactivation takes effect at once)', async () => {
    seedConta(db, 'c1', { selling_partner_id: SPID_A, ativo: false });
    await lerContaEmCache(asDb(db), 'c1');
    seedConta(db, 'c1', { selling_partner_id: SPID_A, ativo: true });
    expect((await lerContaEmCache(asDb(db), 'c1'))?.ativo).toBe(true);
    expect(leiturasDaConta('c1')).toBe(2);
  });

  it('never serves a conta WITHOUT a seller id from cache (a first connect takes effect at once)', async () => {
    seedConta(db, 'c1', { selling_partner_id: null });
    await lerContaEmCache(asDb(db), 'c1');
    seedConta(db, 'c1', { selling_partner_id: SPID_A });
    expect((await lerContaEmCache(asDb(db), 'c1'))?.selling_partner_id).toBe(SPID_A);
    expect(leiturasDaConta('c1')).toBe(2);
  });

  it('never caches absence (a conta created a second ago is found)', async () => {
    expect(await lerContaEmCache(asDb(db), 'nova')).toBeNull();
    seedConta(db, 'nova', { selling_partner_id: SPID_A });
    expect(await lerContaEmCache(asDb(db), 'nova')).not.toBeNull();
  });

  it('invalidarContaEmCache drops THIS instance’s copy', async () => {
    seedConta(db, 'c1', { selling_partner_id: SPID_A, nome: 'Antes' });
    await lerContaEmCache(asDb(db), 'c1');
    seedConta(db, 'c1', { selling_partner_id: SPID_A, nome: 'Depois' });
    expect((await lerContaEmCache(asDb(db), 'c1'))?.nome).toBe('Antes');
    invalidarContaEmCache('c1');
    expect((await lerContaEmCache(asDb(db), 'c1'))?.nome).toBe('Depois');
  });

  it('reads only the conta document — never a credential (token-free by construction)', async () => {
    seedConta(db, 'c1', { selling_partner_id: SPID_A });
    await lerContaEmCache(asDb(db), 'c1');
    expect(db.leituras).toEqual([caminhoConta('c1')]);
  });
});
