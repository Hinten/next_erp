/**
 * The double is only worth what it refuses: every suite above trusts it to fail
 * the way Firestore fails. Each modelled behaviour is pinned here, with the
 * near-miss it must NOT allow. Documents are addressed through the real
 * collection handles, as the app does.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  avisoCollection,
  intFreteCollection,
  integracaoCollection,
  notificacaoAmazonCollection,
  pagamentoCollection,
  pedidoCollection,
  produtoAmazonLinkCollection,
} from '@delfrance/data/admin/collections';

import { FakeDb, asDb, increment } from './fakeDb';

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

const ref = (id: string) => integracaoCollection.docRef(asDb(db), {}, id);
const contas = () => integracaoCollection.ref(asDb(db), {});
const pedidoRef = (id: string) => pedidoCollection.docRef(asDb(db), {}, id);
const pagamentoRef = (id: string) => pagamentoCollection.docRef(asDb(db), { pedidoId: id }, id);
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

describe('queries — only the indexed shapes', () => {
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

  it('refuses any operator but ==, < and in, and a < with a bound that is not a number', () => {
    expect(() => contas().where('tipo', '>', 1)).toThrow(/operador/);
    expect(() => contas().where('tipo', '<=', 1)).toThrow(/operador/);
    expect(() => contas().where('tipo', '<', '1')).toThrow(/numérico/);
    expect(() => contas().where('tipo', '<', null)).toThrow(/numérico/);
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

describe('step 3: the shared notification store’s exact calls on notificacoesAmazon', () => {
  const notif = (id: string) => notificacaoAmazonCollection.docRef(asDb(db), {}, id);
  const notificacoes = () => notificacaoAmazonCollection.ref(asDb(db), {});
  const N = 'notificacoesAmazon/n1';

  it('a merge-set UPSERTS flat fields, keeps the rest, and is logged as `mescla`', async () => {
    db.seed(N, { tipo: 'pedido', status: 'failed', tentativas: 1 });
    await notif('n1').set({ status: 'deferred', tentativas: 0 }, { merge: true });
    expect(db.ler(N)).toEqual({ tipo: 'pedido', status: 'deferred', tentativas: 0 });
    // An upsert, as on the server: a row deleted meanwhile comes back as the patch alone.
    db.apagar(N);
    await notif('n1').set({ status: 'parked' }, { merge: true });
    expect(db.ler(N)).toEqual({ status: 'parked' });
    expect(db.escritasEm(N).map((e) => e.verbo)).toEqual(['mescla', 'mescla']);
  });

  it('near-miss: a merge-set OUTSIDE notificacoesAmazon, another option, or a map value throws', () => {
    expect(() => ref('a').set({ x: 1 }, { merge: true })).toThrow(/merge/);
    expect(() => notif('n1').set({ x: 1 }, { mergeFields: ['x'] })).toThrow(/merge/);
    expect(() => notif('n1').set({ x: 1 }, { merge: false })).toThrow(/merge/);
    expect(() => notif('n1').set({ x: { y: 1 } }, { merge: true })).toThrow(/primitivo/);
    expect(() => notif('n1').set({ x: increment(1) }, { merge: true })).toThrow(/primitivo/);
    expect(db.ler(N)).toBeUndefined();
  });

  it('the redrive is update(): 5 on a removed row, never a ghost', async () => {
    expect(await codigoDe(notif('n1').update({ status: 'failed' }))).toBe(5);
    expect(db.ler(N)).toBeUndefined();
  });

  it('runs the lane query: == status, NUMERIC < processedAt, ordered ascending, capped', async () => {
    db.seed('notificacoesAmazon/c', { status: 'failed', processedAt: 30 });
    db.seed('notificacoesAmazon/a', { status: 'failed', processedAt: 10 });
    db.seed('notificacoesAmazon/b', { status: 'failed', processedAt: 20 });
    db.seed('notificacoesAmazon/d', { status: 'failed', processedAt: 99 });
    db.seed('notificacoesAmazon/e', { status: 'deferred', processedAt: 1 });
    // A null, a string and a missing processedAt never match a numeric bound.
    db.seed('notificacoesAmazon/f', { status: 'failed', processedAt: null });
    db.seed('notificacoesAmazon/g', { status: 'failed', processedAt: '1' });
    db.seed('notificacoesAmazon/h', { status: 'failed' });
    const snap = await notificacoes()
      .where('status', '==', 'failed')
      .where('processedAt', '<', 50)
      .orderBy('processedAt')
      .limit(2)
      .get();
    expect(snap.docs.map((d) => d.id)).toEqual(['a', 'b']);
    expect(db.consultas.at(-1)).toEqual({
      colecao: 'notificacoesAmazon',
      filtros: [
        ['status', 'failed'],
        ['processedAt <', 50],
      ],
      ordens: [['processedAt', 'asc']],
      limite: 2,
      apos: null,
    });
  });

  it.each<[string, (q: ReturnType<typeof notificacoes>) => { get: () => Promise<unknown> }]>([
    [
      'the range without the status equality',
      (q) => q.where('processedAt', '<', 1).orderBy('processedAt'),
    ],
    [
      'the lane query unordered',
      (q) => q.where('status', '==', 'failed').where('processedAt', '<', 1),
    ],
    [
      'the range on another field',
      (q) => q.where('status', '==', 'failed').where('tentativas', '<', 1).orderBy('tentativas'),
    ],
    [
      'the lane shape on another collection',
      () =>
        contas()
          .where('status', '==', 'failed')
          .where('processedAt', '<', 1)
          .orderBy('processedAt'),
    ],
  ])('REFUSES %s (not the declared composite)', async (_c, montar) => {
    await expect(montar(notificacoes()).get()).rejects.toThrow(/fora dos índices/);
  });
});

/* -------------------------------------------------------------------------- */
/*                 step 5 (PR 5-d): getAll, the batch, the group               */
/* -------------------------------------------------------------------------- */

describe('step 5: getAll — ONE consistent read', () => {
  it('answers in the order asked, every snapshot sharing ONE readTime, an absence included', async () => {
    db.seed('pedidos/p', { x: 1 });
    const [a, b] = await db.getAll(pedidoRef('p'), pagamentoRef('p'));
    expect(a?.exists).toBe(true);
    expect(a?.data()).toEqual({ x: 1 });
    expect(a?.updateTime?.isEqual(db.carimboDe('pedidos/p'))).toBe(true);
    expect(b?.exists).toBe(false);
    expect(a?.readTime.isEqual(b?.readTime)).toBe(true);
    expect(db.leituras).toEqual(['pedidos/p', 'pedidos/p/pagamentos/p']);
  });

  it('refuses a read option (a field mask) and a ref it did not build', () => {
    expect(() => db.getAll(pedidoRef('p'), { fieldMask: ['x'] })).toThrow(/opções/);
    expect(() => db.getAll({ path: 'pedidos/p' })).toThrow(/deste fake/);
    expect(() => db.getAll()).toThrow(/sem referências/);
  });
});

describe('step 5: the batch — all or nothing, each write under its own precondition', () => {
  it('lands every write under ONE commit stamp, numbered, and answers one writeTime per write', async () => {
    const lido = db.seed('pedidos/p', { x: 1 });
    const lote = db.batch();
    lote.update(pedidoRef('p'), { x: 2 }, { lastUpdateTime: lido });
    lote.create(pagamentoRef('p'), { y: 1 });
    const resultados = await lote.commit();
    expect(resultados).toHaveLength(2);
    expect(db.ler('pedidos/p')).toEqual({ x: 2 });
    expect(db.ler('pedidos/p/pagamentos/p')).toEqual({ y: 1 });
    const [w1, w2] = db.escritas;
    expect(w1?.lote).toBe(1);
    expect(w2?.lote).toBe(1);
    expect(w1?.comPrecondicao).toBe(true);
    expect(w2?.comPrecondicao).toBe(false);
    expect(w1?.writeTime.isEqual(w2?.writeTime)).toBe(true);
    expect(resultados[0]?.writeTime.isEqual(w1?.writeTime)).toBe(true);
    expect(db.carimboDe('pedidos/p')?.isEqual(w1?.writeTime)).toBe(true);
  });

  it('★ (PR 6) a CONTENT-IDENTICAL update keeps the doc’s stamp and answers the PREVIOUS one; its sibling answers the commit time (the emulator’s measured behaviour)', async () => {
    const lido = db.seed('pedidos/p', { x: 1, mapa: { a: [1, 'b'] } });
    const lote = db.batch();
    lote.update(pedidoRef('p'), { x: 1, mapa: { a: [1, 'b'] } }, { lastUpdateTime: lido });
    lote.create(pagamentoRef('p'), { y: 1 });
    const [carrier, create] = await lote.commit();
    expect(carrier?.writeTime.isEqual(lido)).toBe(true);
    expect(db.carimboDe('pedidos/p')?.isEqual(lido)).toBe(true);
    expect(create?.writeTime.isEqual(lido)).toBe(false);
    expect(create?.writeTime.isEqual(db.carimboDe('pedidos/p/pagamentos/p'))).toBe(true);
    // The write is still logged, with the stamp it answered.
    expect(db.escritas[0]?.writeTime.isEqual(lido)).toBe(true);
    // NEAR-MISS: one changed leaf (deep in a map, or a key order aside) is a real write.
    const lido2 = db.seed('pedidos/q', { x: 1, mapa: { a: [1, 'b'] } });
    const outro = db.batch();
    outro.update(pedidoRef('q'), { mapa: { a: [1, 'c'] } }, { lastUpdateTime: lido2 });
    const [real] = await outro.commit();
    expect(real?.writeTime.isEqual(lido2)).toBe(false);
    expect(db.carimboDe('pedidos/q')?.isEqual(real?.writeTime)).toBe(true);
    const lido3 = db.seed('pedidos/r', { a: 1, b: 2 });
    const ordem = db.batch();
    ordem.update(pedidoRef('r'), { b: 2, a: 1 }, { lastUpdateTime: lido3 });
    const [mesmo] = await ordem.commit();
    expect(mesmo?.writeTime.isEqual(lido3)).toBe(true);
  });

  it('★ a create over an existing doc fails 6 and writes NO sibling', async () => {
    const lido = db.seed('pedidos/p', { x: 1 });
    db.seed('pedidos/p/pagamentos/p', { y: 1 });
    const lote = db.batch();
    lote.update(pedidoRef('p'), { x: 2 }, { lastUpdateTime: lido });
    lote.create(pagamentoRef('p'), { y: 2 });
    expect(await codigoDe(lote.commit())).toBe(6);
    expect(db.ler('pedidos/p')).toEqual({ x: 1 });
    expect(db.escritas).toEqual([]);
  });

  it('★ a stale precondition fails 9 and writes NO sibling — the concurrent writer lands in the hook', async () => {
    const lido = db.seed('pedidos/p', { x: 1 });
    db.antesDaProximaEscrita('pedidos/p', () => {
      db.seed('pedidos/p', { x: 'outro' });
    });
    const lote = db.batch();
    lote.create(pagamentoRef('p'), { y: 1 });
    lote.update(pedidoRef('p'), { x: 2 }, { lastUpdateTime: lido });
    expect(await codigoDe(lote.commit())).toBe(9);
    expect(db.ler('pedidos/p')).toEqual({ x: 'outro' });
    expect(db.ler('pedidos/p/pagamentos/p')).toBeUndefined();
    expect(db.commitsDeLote).toEqual([['pedidos/p/pagamentos/p', 'pedidos/p']]);
  });

  it('an update naming a doc deleted since its read fails 9 under a stamp, 5 without one', async () => {
    const lido = db.seed('pedidos/p', { x: 1 });
    db.apagar('pedidos/p');
    const comStamp = db.batch();
    comStamp.update(pedidoRef('p'), { x: 2 }, { lastUpdateTime: lido });
    expect(await codigoDe(comStamp.commit())).toBe(9);
    const semStamp = db.batch();
    semStamp.update(pedidoRef('p'), { x: 2 });
    expect(await codigoDe(semStamp.commit())).toBe(5);
    expect(db.ler('pedidos/p')).toBeUndefined();
  });

  it('refuses what it does not model: an empty commit, two writes on one path, set, delete, a second commit, a foreign ref', async () => {
    await expect(db.batch().commit()).rejects.toThrow(/vazio/);
    const dois = db.batch();
    dois.create(pedidoRef('p'), { x: 1 });
    expect(() => dois.create(pedidoRef('p'), { x: 2 })).toThrow(/duas escritas/);
    expect(() => db.batch().set()).toThrow(/set/);
    expect(() => db.batch().delete()).toThrow(/delete/);
    const uma = db.batch();
    uma.create(pedidoRef('q'), { x: 1 });
    await uma.commit();
    await expect(uma.commit()).rejects.toThrow(/duas vezes/);
    expect(() => uma.create(pedidoRef('r'), { x: 1 })).toThrow(/já enviado/);
    expect(() => db.batch().create({ path: 'pedidos/z' }, { x: 1 })).toThrow(/deste fake/);
    expect(() => db.batch().update(pedidoRef('p'), {})).toThrow(/vazio/);
    expect(() => db.batch().create(pedidoRef('p'), { x: undefined })).toThrow(/undefined/);
  });

  it('has no method shaped like the multi-document read-and-write call', () => {
    const nomes = [...Object.getOwnPropertyNames(FakeDb.prototype), ...Object.keys(db)];
    expect(nomes.filter((n) => /transa/i.test(n))).toEqual([]);
  });
});

describe('step 5: the prodAmazon collection group and the int_frete lookup', () => {
  const grupo = () => produtoAmazonLinkCollection.groupQuery(asDb(db));
  const FORMAS = ['documents/integracao/c1', 'integracao/c1'];

  it('matches the last collection segment at ANY depth, by `in` + `==`, and names the owner', async () => {
    db.seed('produtos/p1/prodAmazon/l1', { contaAmazonOuterRef: FORMAS[0], sku: 'SKU-1' });
    db.seed('produtos/p2/prodAmazon/l2', { contaAmazonOuterRef: FORMAS[1], sku: 'SKU-1' });
    db.seed('produtos/p3/prodAmazon/l3', {
      contaAmazonOuterRef: 'documents/integracao/c2',
      sku: 'SKU-1',
    });
    db.seed('produtos/p4/prodAmazon/l4', { contaAmazonOuterRef: FORMAS[0], sku: 'sku-1' });
    db.seed('prodAmazon/solto', { contaAmazonOuterRef: FORMAS[0], sku: 'SKU-1' });
    const snap = await grupo()
      .where('contaAmazonOuterRef', 'in', FORMAS)
      .where('sku', '==', 'SKU-1')
      .limit(10)
      .get();
    // The root-level `prodAmazon/solto` is a member too: its owner is `null`.
    expect(snap.docs.map((d) => d.ref.parent.parent?.id ?? 'sem-dono').sort()).toEqual([
      'p1',
      'p2',
      'sem-dono',
    ]);
    expect(db.consultas.at(-1)).toEqual({
      colecao: 'prodAmazon',
      grupo: true,
      filtros: [
        ['contaAmazonOuterRef in', FORMAS],
        ['sku', 'SKU-1'],
      ],
      ordens: [],
      limite: 10,
      apos: null,
    });
  });

  it.each<[string, () => { get: () => Promise<unknown> }]>([
    ['the conta equality alone', () => grupo().where('contaAmazonOuterRef', '==', 'x')],
    [
      'the fields swapped',
      () => grupo().where('sku', '==', 'x').where('contaAmazonOuterRef', 'in', ['x']),
    ],
    [
      'the same shape on ONE produto’s subcollection (not a group query)',
      () =>
        produtoAmazonLinkCollection
          .ref(asDb(db), { produtoId: 'p1' })
          .where('contaAmazonOuterRef', 'in', ['x'])
          .where('sku', '==', 'x'),
    ],
  ])('REFUSES %s', async (_c, montar) => {
    await expect(montar().get()).rejects.toThrow(/fora dos índices/);
  });

  it('refuses an empty or oversized `in`, and a cursor on a group query', () => {
    expect(() => grupo().where('contaAmazonOuterRef', 'in', [])).toThrow(/1 a 30/);
    expect(() =>
      grupo().where(
        'contaAmazonOuterRef',
        'in',
        Array.from({ length: 31 }, (_, i) => i),
      ),
    ).toThrow(/1 a 30/);
    const cursor = { id: 'x', data: () => ({}) } as never;
    expect(() => grupo().startAfter(cursor)).toThrow(/grupo/);
  });

  it('runs the freight lookup’s equality prefix on int_frete', async () => {
    db.seed('int_frete/amz-c1', {
      tipo: 'amz',
      contaAmazonContaFreteAmazonOuterRef: 'documents/integracao/c1',
      ativo: true,
    });
    const snap = await intFreteCollection
      .ref(asDb(db), {})
      .where('tipo', '==', 'amz')
      .where('contaAmazonContaFreteAmazonOuterRef', '==', 'documents/integracao/c1')
      .where('ativo', '==', true)
      .get();
    expect(snap.docs.map((d) => d.id)).toEqual(['amz-c1']);
  });
});
