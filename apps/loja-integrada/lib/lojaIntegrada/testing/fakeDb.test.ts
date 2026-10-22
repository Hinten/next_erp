/**
 * The double's own contract. Every other suite in `lib/lojaIntegrada` trusts it
 * to refuse what the real Admin SDK refuses — a fake that quietly accepted a
 * stale precondition would make every race test vacuous.
 */
import { describe, expect, it } from 'vitest';
import {
  avisoCollection,
  integracaoCollection,
  produtoLojaIntegradaLinkCollection,
} from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';

import { FakeDb, arrayUnion, asDb, grpc, increment } from './fakeDb';

function refDe(db: FakeDb, id: string) {
  return integracaoCollection.docRef(asDb(db), {}, id);
}

describe('FakeDb', () => {
  it('create rejects gRPC 6 on an existing doc; update rejects 5 on a missing one', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    await ref.create({ x: 1 });
    await expect(ref.create({ x: 2 })).rejects.toMatchObject({ code: 6 });
    await expect(refDe(db, 'b').update({ x: 1 })).rejects.toSatisfy(isNotFound);
  });

  it('update under lastUpdateTime on a REMOVED doc is 9, not 5 — the stamp replaces the SDK’s exists check', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    await ref.create({ x: 1 });
    const lido = await ref.get();
    await ref.delete();
    const err: unknown = await ref
      .update({ x: 2 }, { lastUpdateTime: lido.updateTime })
      .catch((e: unknown) => e);
    expect(isFailedPrecondition(err)).toBe(true);
    expect(isNotFound(err)).toBe(false);
    expect(db.ler('integracao/a')).toBeUndefined();
  });

  it('update under lastUpdateTime: a stale stamp is gRPC 9, the current one lands', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    await ref.create({ x: 1 });
    const antes = await ref.get();
    await ref.update({ x: 2 });
    await expect(ref.update({ x: 3 }, { lastUpdateTime: antes.updateTime })).rejects.toSatisfy(
      isFailedPrecondition,
    );
    const agora = await ref.get();
    await ref.update({ x: 4 }, { lastUpdateTime: agora.updateTime });
    expect(db.ler('integracao/a')).toEqual({ x: 4 });
  });

  it('stamps rise strictly by ONE microsecond, so two commits share a millisecond', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    const w1 = await ref.create({ x: 1 });
    const w2 = await ref.update({ x: 2 });
    const us = (t: { seconds: number; nanoseconds: number }) =>
      t.seconds * 1_000_000 + t.nanoseconds / 1000;
    expect(us(w2.writeTime) - us(w1.writeTime)).toBe(1);
    expect(w1.writeTime.toMillis()).toBe(w2.writeTime.toMillis());
    expect(w1.writeTime.isEqual(w2.writeTime)).toBe(false);
    expect((await ref.get()).updateTime?.isEqual(w2.writeTime)).toBe(true);
  });

  it('applies the increment sentinel', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    await ref.create({ n: 1 });
    await ref.update({ n: increment(2) });
    expect(db.ler('integracao/a')).toEqual({ n: 3 });
  });

  it('throws on what it does not model: set, undefined, a dotted key, another operator', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    expect(() => ref.set({ x: 1 })).toThrow(/set\(\) não é modelado/);
    await expect(ref.create({ x: undefined })).rejects.toThrow(/undefined/);
    await ref.create({ x: 1 });
    await expect(ref.update({ 'a.b': 1 })).rejects.toThrow(/ponto/);
    expect(() => integracaoCollection.ref(asDb(db), {}).where('x', '>', 1)).toThrow(/operador/);
  });

  it('delete is idempotent and still reports a commit stamp', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    await ref.create({ x: 1 });
    const d1 = await ref.delete();
    const d2 = await ref.delete();
    expect(d1.writeTime).toBeDefined();
    expect(d2.writeTime.isEqual(d1.writeTime)).toBe(false);
    expect((await ref.get()).exists).toBe(false);
  });

  it('antesDaProximaEscrita lands a concurrent write between a read and a guarded update', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    await ref.create({ x: 1 });
    const lido = await ref.get();
    db.antesDaProximaEscrita('integracao/a', async () => {
      await ref.update({ x: 99 });
    });
    await expect(ref.update({ x: 2 }, { lastUpdateTime: lido.updateTime })).rejects.toSatisfy(
      isFailedPrecondition,
    );
    expect(db.ler('integracao/a')).toEqual({ x: 99 });
  });

  it('query: == filter (absent never matches), orderBy, limit and a doc cursor', async () => {
    const db = new FakeDb();
    db.seed('integracao/c', { tipo: 3, nome: 'C' });
    db.seed('integracao/a', { tipo: 3, nome: 'A' });
    db.seed('integracao/b', { tipo: 3, nome: 'B' });
    db.seed('integracao/x', { tipo: 5, nome: 'X' });
    db.seed('integracao/y', { nome: 'Y' });
    const q = integracaoCollection.ref(asDb(db), {}).where('tipo', '==', 3).orderBy('nome');
    const p1 = await q.limit(2).get();
    expect(p1.docs.map((d) => d.id)).toEqual(['a', 'b']);
    const p2 = await q.limit(2).startAfter(p1.docs[1]).get();
    expect(p2.docs.map((d) => d.id)).toEqual(['c']);
    expect(db.consultas.at(-1)).toEqual({
      colecao: 'integracao',
      filtros: [['tipo', '==', 3]],
      ordens: [['nome', 'asc']],
      limite: 2,
      apos: 'b',
    });
  });

  it('every snapshot carries readTime: the latest stamp, below every later write', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    const w = await ref.create({ tipo: 3, nome: 'A' });
    const ausente = await refDe(db, 'b').get();
    expect(ausente.exists).toBe(false);
    expect(ausente.readTime.isEqual(w.writeTime)).toBe(true);
    const lista = await integracaoCollection.ref(asDb(db), {}).where('tipo', '==', 3).get();
    expect(lista.readTime.isEqual(w.writeTime)).toBe(true);
    const depois = await refDe(db, 'b').create({ x: 1 });
    expect(depois.writeTime.seconds * 1e6 + depois.writeTime.nanoseconds / 1000).toBeGreaterThan(
      ausente.readTime.seconds * 1e6 + ausente.readTime.nanoseconds / 1000,
    );
  });

  it('a query is IMMUTABLE: limit() on a base query leaves the base unchanged', async () => {
    const db = new FakeDb();
    db.seed('integracao/a', { tipo: 3, nome: 'A' });
    db.seed('integracao/b', { tipo: 3, nome: 'B' });
    const base = integracaoCollection.ref(asDb(db), {}).where('tipo', '==', 3);
    expect((await base.limit(1).get()).size).toBe(1);
    expect((await base.get()).size).toBe(2);
    expect((await base.orderBy('nome').get()).docs.map((d) => d.id)).toEqual(['a', 'b']);
    expect((await base.get()).size).toBe(2);
  });

  it('orderBy drops a document LACKING the field, keeps a null one, and puts null FIRST ascending', async () => {
    const db = new FakeDb();
    db.seed('integracao/com', { tipo: 3, nome: 'A' });
    db.seed('integracao/nulo', { tipo: 3, nome: null });
    db.seed('integracao/sem', { tipo: 3 });
    const q = integracaoCollection.ref(asDb(db), {}).where('tipo', '==', 3);
    expect((await q.orderBy('nome').get()).docs.map((d) => d.id)).toEqual(['nulo', 'com']);
    expect((await q.orderBy('nome', 'desc').get()).docs.map((d) => d.id)).toEqual(['com', 'nulo']);
    // Near-miss: with no orderBy the field-less document is there.
    expect((await q.get()).docs.map((d) => d.id).sort()).toEqual(['com', 'nulo', 'sem']);
  });

  it('ties break on the document id, in the direction of the last orderBy', async () => {
    const db = new FakeDb();
    db.seed('integracao/b', { tipo: 3, n: 1 });
    db.seed('integracao/a', { tipo: 3, n: 1 });
    db.seed('integracao/c', { tipo: 3, n: 1 });
    const q = integracaoCollection.ref(asDb(db), {}).where('tipo', '==', 3);
    expect((await q.orderBy('n').get()).docs.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect((await q.orderBy('n', 'desc').get()).docs.map((d) => d.id)).toEqual(['c', 'b', 'a']);
    expect((await q.get()).docs.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('startAfter seeks by the snapshot’s VALUES: a cursor doc that stopped matching pages on', async () => {
    const db = new FakeDb();
    for (const [id, criadoEm] of [
      ['r1', 30],
      ['r2', 20],
      ['r3', 10],
    ] as const) {
      db.seed(`avisos/${id}`, { criadoEm, resolvidoEm: null });
    }
    const q = avisoCollection
      .ref(asDb(db), {})
      .where('resolvidoEm', '==', null)
      .orderBy('criadoEm', 'desc')
      .limit(2);
    const p1 = await q.get();
    expect(p1.docs.map((d) => d.id)).toEqual(['r1', 'r2']);
    const cursor = p1.docs[1];
    if (cursor === undefined) throw new Error('page 1 is short');
    // The cursor document leaves the result (resolved) before the next page.
    db.seed('avisos/r2', { criadoEm: 20, resolvidoEm: 99 });
    const p2 = await q.startAfter(cursor).get();
    expect(p2.docs.map((d) => d.id)).toEqual(['r3']);
    expect(db.consultas.at(-1)?.apos).toBe('r2');
  });

  it('startAfter refuses a snapshot missing an orderBy field, and an orderBy after a cursor', async () => {
    const db = new FakeDb();
    db.seed('integracao/a', { tipo: 3, nome: 'A' });
    db.seed('integracao/b', { tipo: 3 });
    const col = integracaoCollection.ref(asDb(db), {});
    const [semNome] = (await col.where('tipo', '==', 3).get()).docs.filter((d) => d.id === 'b');
    const [comNome] = (await col.orderBy('nome').get()).docs;
    if (semNome === undefined || comNome === undefined) throw new Error('fixture');
    expect(() => col.orderBy('nome').startAfter(semNome)).toThrow(/não tem o campo 'nome'/);
    expect(() => col.startAfter(comNome).orderBy('nome')).toThrow(/orderBy\(\) depois/);
  });
});

describe('FakeDb — what the shared notification store needs (step 3)', () => {
  it("where('<') compares within ONE type: null, absent and other types never match", async () => {
    const db = new FakeDb();
    db.seed('integracao/a', { status: 'failed', processedAt: 10 });
    db.seed('integracao/b', { status: 'failed', processedAt: 20 });
    db.seed('integracao/c', { status: 'failed', processedAt: 30 });
    db.seed('integracao/d', { status: 'failed', processedAt: null });
    db.seed('integracao/e', { status: 'failed' });
    db.seed('integracao/f', { status: 'failed', processedAt: '5' });
    db.seed('integracao/g', { status: 'deferred', processedAt: 1 });
    const snap = await integracaoCollection
      .ref(asDb(db), {})
      .where('status', '==', 'failed')
      .where('processedAt', '<', 30)
      .orderBy('processedAt')
      .limit(10)
      .get();
    expect(snap.docs.map((d) => d.id)).toEqual(['a', 'b']);
    expect(db.consultas.at(-1)?.filtros).toEqual([
      ['status', '==', 'failed'],
      ['processedAt', '<', 30],
    ]);
    // Near-miss: the bound itself is excluded (strictly below).
    const ate20 = await integracaoCollection.ref(asDb(db), {}).where('processedAt', '<', 20).get();
    expect(ate20.docs.map((d) => d.id).sort()).toEqual(['a', 'g']);
  });

  it("where('<') refuses a bound it does not model, and '>' stays refused", () => {
    const col = integracaoCollection.ref(asDb(new FakeDb()), {});
    expect(() => col.where('x', '<', null)).toThrow(/número ou texto/);
    expect(() => col.where('x', '<', true)).toThrow(/número ou texto/);
    expect(() => col.where('x', '>', 1)).toThrow(/operador/);
  });

  it('set(…, { merge: true }) upserts flat fields, keeps the others, and logs a set', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    await ref.set({ x: 1 }, { merge: true });
    expect(db.ler('integracao/a')).toEqual({ x: 1 });
    await ref.update({ y: 2 });
    const w = await ref.set({ x: 3, n: increment(1) }, { merge: true });
    expect(db.ler('integracao/a')).toEqual({ x: 3, y: 2, n: 1 });
    expect(db.escritasEm('integracao/a').map((e) => e.verbo)).toEqual(['set', 'update', 'set']);
    expect((await ref.get()).updateTime?.isEqual(w.writeTime)).toBe(true);
  });

  it('set refuses every form it does not model — synchronously, before anything lands', () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    expect(() => ref.set({ x: 1 })).toThrow(/set\(\) não é modelado/);
    expect(() => ref.set({ x: 1 }, { merge: false })).toThrow(/set\(\) não é modelado/);
    expect(() => ref.set({ x: 1 }, { mergeFields: ['x'] })).toThrow(/set\(\) não é modelado/);
    expect(() => ref.set({ m: { a: 1 } }, { merge: true })).toThrow(/mapa aninhado/);
    expect(() => ref.set({ 'a.b': 1 }, { merge: true })).toThrow(/ponto/);
    expect(() => ref.set({ x: undefined }, { merge: true })).toThrow(/undefined/);
    expect(db.escritas).toEqual([]);
  });

  it('a merge-set meets an interleaved write like any other write', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    await ref.create({ status: 'deferred', tentativas: 5 });
    db.antesDaProximaEscrita('integracao/a', async () => {
      await ref.update({ status: 'failed', tentativas: 0 });
    });
    await ref.set({ status: 'deferred', tentativas: 6 }, { merge: true });
    // The merge-set lands LAST and wins — the real server's behaviour too.
    expect(db.ler('integracao/a')).toEqual({ status: 'deferred', tentativas: 6 });
  });
});

describe('FakeDb — the array-union sentinel (step 20, the freight mapa)', () => {
  it('an absent, null or non-array field becomes exactly the elements', async () => {
    const db = new FakeDb();
    await refDe(db, 'a').create({ outro: 1 });
    await refDe(db, 'b').create({ l: null });
    await refDe(db, 'c').create({ l: { chave: 'um mapa' } });
    await refDe(db, 'd').create({ l: 'texto' });
    await refDe(db, 'a').update({ l: arrayUnion({ k: 1 }, 'x') });
    await refDe(db, 'b').update({ l: arrayUnion({ k: 1 }) });
    await refDe(db, 'c').update({ l: arrayUnion({ k: 1 }) });
    await refDe(db, 'd').update({ l: arrayUnion({ k: 1 }) });
    expect(db.ler('integracao/a')).toEqual({ outro: 1, l: [{ k: 1 }, 'x'] });
    expect(db.ler('integracao/b')).toEqual({ l: [{ k: 1 }] });
    expect(db.ler('integracao/c')).toEqual({ l: [{ k: 1 }] });
    expect(db.ler('integracao/d')).toEqual({ l: [{ k: 1 }] });
  });

  it('an array keeps every stored element untouched and gains, in order, each element not already there', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    const legado = [{ b: 2, a: 1, extra: [1, { z: null }] }, 'solto', null, 7];
    await ref.create({ l: legado });
    // EQUAL: the same key SET in another order, an equal nested array.
    await ref.update({ l: arrayUnion({ a: 1, extra: [1, { z: null }], b: 2 }, 'solto', 7) });
    expect(db.ler('integracao/a')).toEqual({ l: legado });
    // NEAR-MISS: a number and its string, 0 and null, another nested length, one key more.
    const quase = [
      '7',
      0,
      { a: 1, extra: [1], b: 2 },
      { a: 1, b: 2, extra: [1, { z: null }], c: 0 },
    ];
    await ref.update({ l: arrayUnion(...quase) });
    expect(db.ler('integracao/a')).toEqual({ l: [...legado, ...quase] });
  });

  it('duplicates among the elements land once; the write log keeps the sentinel, not the merged array', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    await ref.create({ l: [] });
    await ref.update({ l: arrayUnion({ k: 1 }, { k: 1 }) });
    expect(db.ler('integracao/a')).toEqual({ l: [{ k: 1 }] });
    expect(db.escritasEm('integracao/a').at(-1)?.dados).toEqual({
      l: { __arrayUnion: [{ k: 1 }, { k: 1 }] },
    });
  });

  it('a stale lastUpdateTime refuses the union with 9 and applies nothing', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    await ref.create({ l: ['a'] });
    const lido = await ref.get();
    await ref.update({ outro: 1 });
    await expect(
      ref.update({ l: arrayUnion('b') }, { lastUpdateTime: lido.updateTime }),
    ).rejects.toSatisfy(isFailedPrecondition);
    expect(db.ler('integracao/a')).toEqual({ l: ['a'], outro: 1 });
  });

  it('refuses it where it is not modelled: create, a merge-set, an undefined inside an element', async () => {
    const db = new FakeDb();
    const ref = refDe(db, 'a');
    await expect(ref.create({ l: arrayUnion('a') })).rejects.toThrow(/arrayUnion em create/);
    expect(() => ref.set({ l: arrayUnion('a') }, { merge: true })).toThrow(
      /arrayUnion em set merge/,
    );
    await ref.create({ l: [] });
    await expect(ref.update({ l: arrayUnion({ k: undefined }) })).rejects.toThrow(/undefined/);
    expect(db.ler('integracao/a')).toEqual({ l: [] });
  });
});

describe('FakeDb — the batch (step 5, the pedido and its pagamentos)', () => {
  function refsDe(db: FakeDb) {
    const banco = asDb(db);
    return {
      a: integracaoCollection.docRef(banco, {}, 'a'),
      b: integracaoCollection.docRef(banco, {}, 'b'),
      c: integracaoCollection.docRef(banco, {}, 'c'),
    };
  }

  it('all the writes land under ONE commit stamp, each logged with its batch number', async () => {
    const db = new FakeDb();
    const { a, b } = refsDe(db);
    await a.create({ x: 1 });
    const lido = await a.get();
    const lote = asDb(db).batch();
    lote.update(a, { x: 2 }, { lastUpdateTime: lido.updateTime });
    lote.create(b, { y: 1 });
    const resultados = await lote.commit();
    expect(db.ler('integracao/a')).toEqual({ x: 2 });
    expect(db.ler('integracao/b')).toEqual({ y: 1 });
    expect(resultados).toHaveLength(2);
    const [ea, eb] = db.escritas.slice(-2);
    expect(ea?.writeTime.isEqual(eb?.writeTime)).toBe(true);
    expect([ea?.lote, eb?.lote]).toEqual([1, 1]);
    expect(db.carimboDe('integracao/a')?.isEqual(db.carimboDe('integracao/b'))).toBe(true);
    // A single-document write carries no batch number.
    expect(db.escritas[0]?.lote).toBeUndefined();
  });

  it('a create on an EXISTING doc rejects 6 and writes NOTHING — the other write included', async () => {
    const db = new FakeDb();
    const { a, b } = refsDe(db);
    await a.create({ x: 1 });
    const antes = db.escritas.length;
    const lote = asDb(db).batch();
    lote.create(b, { y: 1 });
    lote.create(a, { x: 9 });
    await expect(lote.commit()).rejects.toSatisfy(isAlreadyExists);
    expect(db.ler('integracao/b')).toBeUndefined();
    expect(db.ler('integracao/a')).toEqual({ x: 1 });
    expect(db.escritas).toHaveLength(antes);
  });

  it('an update under a STALE lastUpdateTime rejects 9 and writes nothing', async () => {
    const db = new FakeDb();
    const { a, b } = refsDe(db);
    await a.create({ x: 1 });
    const lido = await a.get();
    await a.update({ x: 2 });
    const lote = asDb(db).batch();
    lote.create(b, { y: 1 });
    lote.update(a, { x: 3 }, { lastUpdateTime: lido.updateTime });
    const err: unknown = await lote.commit().catch((e: unknown) => e);
    expect(isFailedPrecondition(err)).toBe(true);
    expect(db.ler('integracao/a')).toEqual({ x: 2 });
    expect(db.ler('integracao/b')).toBeUndefined();
  });

  it('an update under lastUpdateTime on a REMOVED doc rejects 9 (not 5) and resurrects nothing', async () => {
    const db = new FakeDb();
    const { a, b } = refsDe(db);
    await a.create({ x: 1 });
    const lido = await a.get();
    await a.delete();
    const lote = asDb(db).batch();
    lote.update(a, { x: 3 }, { lastUpdateTime: lido.updateTime });
    lote.create(b, { y: 1 });
    const err: unknown = await lote.commit().catch((e: unknown) => e);
    expect(isFailedPrecondition(err)).toBe(true);
    expect(isNotFound(err)).toBe(false);
    expect(db.ler('integracao/a')).toBeUndefined();
    expect(db.ler('integracao/b')).toBeUndefined();
  });

  it('a plain update of a missing doc rejects 5, and nothing lands', async () => {
    const db = new FakeDb();
    const { a, b } = refsDe(db);
    const lote = asDb(db).batch();
    lote.create(b, { y: 1 });
    lote.update(a, { x: 1 });
    await expect(lote.commit()).rejects.toSatisfy(isNotFound);
    expect(db.ler('integracao/b')).toBeUndefined();
  });

  it('the concurrent writer of antesDaProximaEscrita lands BEFORE the checks: its write fails the batch whole', async () => {
    const db = new FakeDb();
    const { a, b } = refsDe(db);
    await a.create({ x: 1 });
    const lido = await a.get();
    db.antesDaProximaEscrita('integracao/a', async () => {
      await a.update({ x: 'outro escritor' });
    });
    const lote = asDb(db).batch();
    lote.update(a, { x: 2 }, { lastUpdateTime: lido.updateTime });
    lote.create(b, { y: 1 });
    await expect(lote.commit()).rejects.toSatisfy(isFailedPrecondition);
    expect(db.ler('integracao/a')).toEqual({ x: 'outro escritor' });
    expect(db.ler('integracao/b')).toBeUndefined();
  });

  it('an injected write failure on ANY path of the batch rejects it whole', async () => {
    const db = new FakeDb();
    const { a, b } = refsDe(db);
    db.falharEscrita('integracao/b', grpc(14, 'UNAVAILABLE'));
    const lote = asDb(db).batch();
    lote.create(a, { x: 1 });
    lote.create(b, { y: 1 });
    await expect(lote.commit()).rejects.toMatchObject({ code: 14 });
    expect(db.ler('integracao/a')).toBeUndefined();
  });

  it('refuses what it does not model: two writes on one path, an empty or a second commit, set/delete, a bad payload', async () => {
    const db = new FakeDb();
    const { a, b, c } = refsDe(db);
    const dupla = asDb(db).batch();
    dupla.create(a, { x: 1 });
    expect(() => dupla.create(a, { x: 2 })).toThrow(/duas escritas/);
    await expect(asDb(db).batch().commit()).rejects.toThrow(/lote vazio/);
    expect(() => asDb(db).batch().set(a, { x: 1 })).toThrow(/set\(\) num lote/);
    expect(() => asDb(db).batch().delete(a)).toThrow(/delete\(\) num lote/);
    expect(() => asDb(db).batch().create(b, { x: undefined })).toThrow(/undefined/);
    expect(() => asDb(db).batch().update(b, {})).toThrow(/update vazio/);
    expect(() => asDb(db).batch().update(b, { 'p.q': 1 })).toThrow(/chave com ponto/);
    expect(() =>
      asDb(db)
        .batch()
        .create(b, { n: increment(1) }),
    ).toThrow(/increment em create/);
    const unica = asDb(db).batch();
    unica.create(c, { z: 1 });
    await unica.commit();
    await expect(unica.commit()).rejects.toThrow(/duas vezes/);
    expect(() => unica.create(b, { y: 1 })).toThrow(/já enviado/);
  });

  it('a nested map is a WHOLE-field value on update, exactly as the server applies one', async () => {
    const db = new FakeDb();
    const { a } = refsDe(db);
    await a.create({ m: { p: 1, q: 2 }, outro: 1 });
    const lido = await a.get();
    const lote = asDb(db).batch();
    lote.update(a, { m: { p: 9 } }, { lastUpdateTime: lido.updateTime });
    await lote.commit();
    expect(db.ler('integracao/a')).toEqual({ m: { p: 9 }, outro: 1 });
  });
});

describe('FakeDb — collection groups and `in` (step 5, the link docs)', () => {
  it('a group query reads the LAST collection segment at any depth; each doc carries its owner as ref.parent.parent', async () => {
    const db = new FakeDb();
    db.seed('produtos/p1/produtolojaintegrada/l1', { conta: 'documents/integracao/c', id: 7 });
    db.seed('produtos/p2/produtolojaintegrada/l2', { conta: 'integracao/c', id: 7 });
    db.seed('produtos/p3/produtolojaintegrada/l3', { conta: 'documents/integracao/outra', id: 7 });
    db.seed('produtos/p4/outra/l4', { conta: 'documents/integracao/c', id: 7 });
    db.seed('produtolojaintegrada/raiz', { conta: 'documents/integracao/c', id: 7 });
    const snap = await produtoLojaIntegradaLinkCollection
      .groupQuery(asDb(db))
      .where('conta', 'in', ['documents/integracao/c', 'integracao/c'])
      .where('id', '==', 7)
      .get();
    // A ROOT-level doc of that id has no owner: `parent.parent` is null.
    expect(snap.docs.map((d) => d.ref.parent.parent?.id ?? '<raiz>').sort()).toEqual([
      '<raiz>',
      'p1',
      'p2',
    ]);
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['l1', 'l2', 'raiz']);
    expect(db.consultas.at(-1)).toMatchObject({ colecao: 'produtolojaintegrada', grupo: true });
  });

  it('`in` is `===` against each value: a number is not its text, a missing field never matches', async () => {
    const db = new FakeDb();
    db.seed('integracao/a', { v: 7 });
    db.seed('integracao/b', { v: '7' });
    db.seed('integracao/c', {});
    const snap = await integracaoCollection.ref(asDb(db), {}).where('v', 'in', [7]).get();
    expect(snap.docs.map((d) => d.id)).toEqual(['a']);
  });

  it('refuses an empty or oversized `in` — before any read, as the SDK does', () => {
    const ref = integracaoCollection.ref(asDb(new FakeDb()), {});
    expect(() => ref.where('v', 'in', [])).toThrow(/1 a 30/);
    expect(() =>
      ref.where(
        'v',
        'in',
        Array.from({ length: 31 }, (_, i) => i),
      ),
    ).toThrow(/1 a 30/);
  });
});
