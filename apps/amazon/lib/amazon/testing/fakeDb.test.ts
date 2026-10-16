/**
 * The double is only worth what it refuses: every suite above trusts it to fail
 * the way Firestore fails. Each modelled behaviour is pinned here, with the
 * near-miss it must NOT allow. Documents are addressed through the real
 * collection handles, as the app does.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { avisoCollection, integracaoCollection } from '@delfrance/data/admin/collections';

import { FakeDb, asDb, increment } from './fakeDb';

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

const ref = (id: string) => integracaoCollection.docRef(asDb(db), {}, id);
const contas = () => integracaoCollection.ref(asDb(db), {});
const CAMINHO = 'integracao/a';

function codigoDe(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (err: unknown) => (err as { code?: number }).code,
  );
}

describe('writes', () => {
  it('create → 6 on an existing doc', async () => {
    db.seed(CAMINHO, { x: 1 });
    expect(await codigoDe(ref('a').create({ x: 2 }))).toBe(6);
  });

  it('update without precondition → 5 on a missing doc (never creates it)', async () => {
    expect(await codigoDe(ref('a').update({ x: 1 }))).toBe(5);
    expect(db.ler(CAMINHO)).toBeUndefined();
  });

  it('update under a stale lastUpdateTime → 9; under a removed one → 9 too (not 5)', async () => {
    const velho = db.seed(CAMINHO, { x: 1 });
    db.seed(CAMINHO, { x: 2 });
    expect(await codigoDe(ref('a').update({ x: 3 }, { lastUpdateTime: velho as never }))).toBe(9);
    const atual = db.carimboDe(CAMINHO);
    db.apagar(CAMINHO);
    expect(await codigoDe(ref('a').update({ x: 3 }, { lastUpdateTime: atual as never }))).toBe(9);
    expect(db.ler(CAMINHO)).toBeUndefined();
  });

  it('update under the CURRENT stamp lands, compared by value (two reads are two objects)', async () => {
    db.seed(CAMINHO, { x: 1 });
    const lido = (await ref('a').get()).updateTime;
    await ref('a').update({ x: 2 }, { lastUpdateTime: lido as never });
    expect(db.ler(CAMINHO)).toEqual({ x: 2 });
  });

  it('set is a FULL overwrite; set with merge is refused (nothing here upserts a patch)', async () => {
    db.seed(CAMINHO, { x: 1, y: 1 });
    await ref('a').set({ x: 2 });
    expect(db.ler(CAMINHO)).toEqual({ x: 2 });
    expect(() => ref('a').set({ y: 3 }, { merge: true })).toThrow(/merge/);
  });

  it('applies the increment sentinel; refuses undefined anywhere', async () => {
    db.seed(CAMINHO, { n: 1 });
    await ref('a').update({ n: increment(2) });
    expect(db.ler(CAMINHO)).toEqual({ n: 3 });
    await expect(ref('a').update({ n: undefined })).rejects.toThrow(/undefined/);
  });

  it('stamps rise by ONE MICROSECOND: two commits share a millisecond', async () => {
    db.seed(CAMINHO, { x: 1 });
    const w1 = (await ref('a').update({ x: 2 })).writeTime;
    const w2 = (await ref('a').update({ x: 3 })).writeTime;
    expect(w2.toMillis()).toBe(w1.toMillis());
    expect(w2.nanoseconds - w1.nanoseconds).toBe(1000);
  });

  it('a hook runs between a read and the write, and its own writes are not intercepted', async () => {
    db.seed(CAMINHO, { x: 1 });
    const lido = (await ref('a').get()).updateTime;
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await ref('a').update({ x: 'concorrente' });
    });
    expect(await codigoDe(ref('a').update({ x: 2 }, { lastUpdateTime: lido as never }))).toBe(9);
    expect(db.ler(CAMINHO)).toEqual({ x: 'concorrente' });
  });
});

describe('reads', () => {
  it('a snapshot readTime orders an absence before any later write', async () => {
    const snap = await ref('a').get();
    expect(snap.exists).toBe(false);
    const depois = db.seed(CAMINHO, { x: 1 });
    expect(depois.seconds * 1e6 + depois.nanoseconds / 1000).toBeGreaterThan(
      snap.readTime.seconds * 1e6 + snap.readTime.nanoseconds / 1000,
    );
  });
});

describe('queries — only the three indexed shapes', () => {
  it('runs the seller-guard shape with exact equality (a missing field never matches)', async () => {
    db.seed('integracao/a', { tipo: 8, selling_partner_id: 'S', ativo: true });
    db.seed('integracao/b', { tipo: 8, ativo: true });
    db.seed('integracao/a/credenciais/current', { tipo: 8, selling_partner_id: 'S', ativo: true });
    const snap = await contas()
      .where('tipo', '==', 8)
      .where('selling_partner_id', '==', 'S')
      .where('ativo', '==', true)
      .limit(2)
      .get();
    // A subcollection document is never a member of the parent collection.
    expect(snap.docs.map((d) => d.id)).toEqual(['a']);
  });

  it.each([
    ['a prefix of the seller shape (no ativo)', ['tipo', 'selling_partner_id'], []],
    ['the clauses reordered', ['selling_partner_id', 'tipo', 'ativo'], []],
    ['tipo alone, unordered', ['tipo'], []],
    ['an extra filter on the enumeration', ['tipo', 'ativo'], ['nome']],
  ])('REFUSES %s (an unindexed shape full-scans on Enterprise)', async (_c, filtros, ordens) => {
    let q = contas() as unknown as {
      where: (c: string, o: string, v: unknown) => typeof q;
      orderBy: (c: string) => typeof q;
      get: () => Promise<unknown>;
    };
    for (const f of filtros) q = q.where(f, '==', 1);
    for (const o of ordens) q = q.orderBy(o);
    await expect(q.get()).rejects.toThrow(/fora dos índices/);
  });

  it('refuses any operator but ==', () => {
    expect(() => contas().where('tipo', '>', 1)).toThrow(/operador/);
  });

  it('orderBy drops a doc LACKING the field and keeps a null; startAfter seeks by values', async () => {
    db.seed('avisos/a', { resolvidoEm: null, criadoEm: 3 });
    db.seed('avisos/b', { resolvidoEm: null, criadoEm: 2 });
    db.seed('avisos/c', { resolvidoEm: null });
    const base = avisoCollection
      .ref(asDb(db), {})
      .where('resolvidoEm', '==', null)
      .orderBy('criadoEm', 'desc')
      .limit(1);
    const p1 = await base.get();
    expect(p1.docs.map((d) => d.id)).toEqual(['a']);
    // The cursor row stops matching; paging continues past its VALUES.
    db.seed('avisos/a', { resolvidoEm: 99, criadoEm: 3 });
    const cursor = p1.docs[0];
    if (cursor === undefined) throw new Error('sem cursor');
    const p2 = await base.startAfter(cursor).get();
    expect(p2.docs.map((d) => d.id)).toEqual(['b']);
  });
});
