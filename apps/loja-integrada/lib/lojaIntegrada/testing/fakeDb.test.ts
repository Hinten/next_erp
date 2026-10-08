/**
 * The double's own contract. Every other suite in `lib/lojaIntegrada` trusts it
 * to refuse what the real Admin SDK refuses — a fake that quietly accepted a
 * stale precondition would make every race test vacuous.
 */
import { describe, expect, it } from 'vitest';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';

import { FakeDb, asDb, increment } from './fakeDb';

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
});
