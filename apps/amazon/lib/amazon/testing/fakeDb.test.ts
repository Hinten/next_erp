/**
 * The double is only worth what it refuses: every suite above trusts it to fail
 * the way Firestore fails. Each modelled behaviour is pinned here, with the
 * near-miss it must NOT allow. Documents are addressed through the real
 * collection handles, as the app does.
 */
import { FieldPath } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  avisoCollection,
  estoqueCollection,
  intFreteCollection,
  integracaoCollection,
  nfev4Collection,
  notificacaoAmazonCollection,
  pagamentoCollection,
  pedidoCollection,
  produtoAmazonLinkCollection,
  produtoCollection,
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
const produtoRef = (id: string) => produtoCollection.docRef(asDb(db), {}, id);
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

  it('refuses any operator but ==, in, <, <= and > (12-e2), and a range bound that is not a number', () => {
    for (const op of ['>=', '!=', 'not-in', 'array-contains', 'array-contains-any', '=<', '=']) {
      // Typed as the SDK's union on purpose: two of these are not even SDK operators.
      expect(() => contas().where('tipo', op as never, 1), op).toThrow(/operador/);
    }
    for (const op of ['<', '<=', '>'] as const) {
      expect(() => contas().where('tipo', op, '1'), op).toThrow(/numérico/);
      expect(() => contas().where('tipo', op, null), op).toThrow(/numérico/);
      // A modelled operator with a number bound builds; the SHAPE is judged at get().
      expect(() => contas().where('tipo', op, 1), op).not.toThrow();
    }
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

  it('refuses any read option but a field mask, and a ref it did not build', () => {
    // (step 12, PR 12-e1) the field mask is modelled now; every OTHER option is the near-miss.
    expect(() => db.getAll(pedidoRef('p'), { readTime: 1 })).toThrow(/opções/);
    expect(() => db.getAll(pedidoRef('p'), { fieldMask: ['x'], transaction: {} })).toThrow(
      /opções/,
    );
    expect(() => db.getAll(pedidoRef('p'), { fieldMask: 'x' })).toThrow(/opções/);
    expect(() => db.getAll(pedidoRef('p'), {})).toThrow(/opções/);
    expect(() => db.getAll({ fieldMask: ['x'] }, pedidoRef('p'))).toThrow(/última posição/);
    expect(() => db.getAll({ path: 'pedidos/p' })).toThrow(/deste fake/);
    expect(() => db.getAll()).toThrow(/sem referências/);
    expect(() => db.getAll({ fieldMask: ['x'] })).toThrow(/sem referências/);
    expect(db.leituras).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*            step 12 (PR 12-e1): field masks, projections, the counter        */
/* -------------------------------------------------------------------------- */

describe('step 12 (12-e1): getAll with a field mask', () => {
  const link = (produtoId: string, id: string) =>
    produtoAmazonLinkCollection.docRef(asDb(db), { produtoId }, id);

  it('★ answers ONLY the masked fields a document holds; NEAR-MISS: an unmasked field reads undefined', async () => {
    db.seed('produtos/p/prodAmazon/l', {
      sku: 'SKU-1',
      asin: 'B0TESTE',
      productDataJson: { pesado: true },
      envioEstoqueAmazon: null,
    });
    const [snap] = await db.getAll(link('p', 'l'), {
      fieldMask: ['sku', 'envioEstoqueAmazon', 'ausente'],
    });
    // A masked field the document lacks stays absent; a stored null comes back null.
    expect(snap?.data()).toEqual({ sku: 'SKU-1', envioEstoqueAmazon: null });
    expect(Object.keys(snap?.data() ?? {}).sort()).toEqual(['envioEstoqueAmazon', 'sku']);
    expect(snap?.data()?.asin).toBeUndefined();
    expect(snap?.data()?.productDataJson).toBeUndefined();
    // Unmasked, the same read answers every field.
    const [inteiro] = await db.getAll(link('p', 'l'));
    expect(inteiro?.data()?.asin).toBe('B0TESTE');
  });

  it('★ a masked snapshot keeps exists, updateTime and the shared readTime (it still feeds a precondition)', async () => {
    const carimbo = db.seed('produtos/p/prodAmazon/l', { sku: 'S', asin: 'A' });
    const [a, b] = await db.getAll(link('p', 'l'), link('p', 'ausente'), { fieldMask: ['sku'] });
    expect(a?.exists).toBe(true);
    expect(a?.updateTime?.isEqual(carimbo)).toBe(true);
    expect(b?.exists).toBe(false);
    expect(b?.data()).toBeUndefined();
    expect(a?.readTime.isEqual(b?.readTime)).toBe(true);
    await link('p', 'l').update({ asin: 'B' }, { lastUpdateTime: a?.updateTime as never });
    expect(db.ler('produtos/p/prodAmazon/l')).toEqual({ sku: 'S', asin: 'B' });
  });

  it('an EMPTY mask answers the keys alone', async () => {
    db.seed('produtos/p', { nome: 'P' });
    const [snap] = await db.getAll(produtoRef('p'), { fieldMask: [] });
    expect(snap?.exists).toBe(true);
    expect(snap?.data()).toEqual({});
  });

  it('refuses a field path it does not model: dotted, empty, not a string', () => {
    expect(() => db.getAll(produtoRef('p'), { fieldMask: ['a.b'] })).toThrow(/primeiro nível/);
    expect(() => db.getAll(produtoRef('p'), { fieldMask: [''] })).toThrow(/primeiro nível/);
    expect(() => db.getAll(produtoRef('p'), { fieldMask: [{ segmentos: ['a'] }] })).toThrow(
      /primeiro nível/,
    );
  });

  it('★ logs every document read with its mask and its getAll call; get() and an unmasked read log null', async () => {
    db.seed('produtos/p', { nome: 'P', paiId: null });
    await db.getAll(produtoRef('p'), produtoRef('q'), { fieldMask: ['paiId'] });
    await produtoRef('p').get();
    await db.getAll(produtoRef('p'));
    expect(db.leiturasDetalhadas).toEqual([
      { caminho: 'produtos/p', via: 'getAll', chamada: 1, mascara: ['paiId'] },
      { caminho: 'produtos/q', via: 'getAll', chamada: 1, mascara: ['paiId'] },
      { caminho: 'produtos/p', via: 'get', mascara: null },
      { caminho: 'produtos/p', via: 'getAll', chamada: 2, mascara: null },
    ]);
    expect(db.leituras).toEqual(['produtos/p', 'produtos/q', 'produtos/p', 'produtos/p']);
  });
});

describe('step 12 (12-e1): a query’s classic select()', () => {
  const grupo = () => produtoAmazonLinkCollection.groupQuery(asDb(db));
  const FORMA = 'documents/integracao/c1';

  it('★ projects every document to the selected fields, and the log names the projection', async () => {
    db.seed('produtos/p1/prodAmazon/l1', {
      contaAmazonOuterRef: FORMA,
      sku: 'SKU-1',
      asin: 'A1',
      productDataJson: { pesado: true },
    });
    const snap = await grupo()
      .where('contaAmazonOuterRef', 'in', [FORMA])
      .where('sku', '==', 'SKU-1')
      .limit(10)
      .select('sku', 'asin')
      .get();
    expect(snap.docs.map((d) => d.data())).toEqual([{ sku: 'SKU-1', asin: 'A1' }]);
    expect(snap.docs[0]?.ref.parent.parent?.id).toBe('p1');
    expect(db.consultas.at(-1)).toEqual({
      colecao: 'prodAmazon',
      grupo: true,
      filtros: [
        ['contaAmazonOuterRef in', [FORMA]],
        ['sku', 'SKU-1'],
      ],
      ordens: [],
      limite: 10,
      apos: null,
      selecao: ['sku', 'asin'],
    });
  });

  it('NEAR-MISS: without select() the documents come back whole and the log carries no projection', async () => {
    db.seed('produtos/p1/prodAmazon/l1', { contaAmazonOuterRef: FORMA, sku: 'S', asin: 'A' });
    const snap = await grupo()
      .where('contaAmazonOuterRef', 'in', [FORMA])
      .where('sku', '==', 'S')
      .get();
    expect(snap.docs[0]?.data()).toEqual({ contaAmazonOuterRef: FORMA, sku: 'S', asin: 'A' });
    expect(db.consultas.at(-1)).not.toHaveProperty('selecao');
  });

  it('select() with no field answers the keys alone; a later select replaces an earlier one', async () => {
    db.seed('produtos/p1/prodAmazon/l1', { contaAmazonOuterRef: FORMA, sku: 'S', asin: 'A' });
    const base = grupo().where('contaAmazonOuterRef', 'in', [FORMA]).where('sku', '==', 'S');
    const chaves = await base.select().get();
    expect(chaves.docs.map((d) => [d.id, d.data()])).toEqual([['l1', {}]]);
    expect(db.consultas.at(-1)?.selecao).toEqual([]);
    const trocado = await base.select('sku').select('asin').get();
    expect(trocado.docs[0]?.data()).toEqual({ asin: 'A' });
  });

  it('refuses a field path it does not model', () => {
    expect(() => grupo().select('a.b')).toThrow(/primeiro nível/);
    expect(() => grupo().select('')).toThrow(/primeiro nível/);
  });
});

describe('step 12 (12-e1): the unit-children seek — shape 8', () => {
  const produtos = () => produtoCollection.ref(asDb(db), {});

  it('runs `paiId ==` · orderBy(nome) · limit, keys only; a child LACKING nome is dropped, as on the server', async () => {
    db.seed('produtos/b', { paiId: 'u', nome: 'Beta' });
    db.seed('produtos/a', { paiId: 'u', nome: 'Alfa' });
    db.seed('produtos/c', { paiId: 'u', nome: 'Gama' });
    db.seed('produtos/semNome', { paiId: 'u' });
    db.seed('produtos/outro', { paiId: 'v', nome: 'Alfa' });
    const snap = await produtos().where('paiId', '==', 'u').orderBy('nome').limit(2).select().get();
    expect(snap.docs.map((d) => d.id)).toEqual(['a', 'b']);
    expect(snap.docs.map((d) => d.data())).toEqual([{}, {}]);
    const todos = await produtos().where('paiId', '==', 'u').orderBy('nome').get();
    expect(todos.docs.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it.each<[string, () => { get: () => Promise<unknown> }]>([
    ['the equality alone, unordered', () => produtos().where('paiId', '==', 'u')],
    ['ordered by another field', () => produtos().where('paiId', '==', 'u').orderBy('sku')],
    ['ordered descending', () => produtos().where('paiId', '==', 'u').orderBy('nome', 'desc')],
    [
      'the collection group',
      () => produtoCollection.groupQuery(asDb(db)).where('paiId', '==', 'u'),
    ],
  ])('NEAR-MISS: REFUSES %s', async (_c, montar) => {
    await expect(montar().get()).rejects.toThrow(/fora dos índices/);
  });
});

describe('step 12 (12-e1): exigirMascaraEm — a collection whose reads must be masked', () => {
  const link = (produtoId: string, id: string) =>
    produtoAmazonLinkCollection.docRef(asDb(db), { produtoId }, id);
  const grupo = () =>
    produtoAmazonLinkCollection
      .groupQuery(asDb(db))
      .where('contaAmazonOuterRef', 'in', ['x'])
      .where('sku', '==', 'S');

  it('★ NEAR-MISS: an UNMASKED getAll of a link doc, its get() and an unprojected query throw', async () => {
    db.seed('produtos/p/prodAmazon/l', { sku: 'S' });
    db.exigirMascaraEm('prodAmazon');
    expect(() => db.getAll(link('p', 'l'))).toThrow(/sem máscara/);
    expect(() => link('p', 'l').get()).toThrow(/sem máscara/);
    await expect(grupo().get()).rejects.toThrow(/sem select/);
    // A mixed getAll is refused whole: nothing was read.
    expect(() => db.getAll(produtoRef('p'), link('p', 'l'))).toThrow(/sem máscara/);
    expect(db.leituras).toEqual([]);
  });

  it('the masked reads pass, and another collection is untouched', async () => {
    db.seed('produtos/p/prodAmazon/l', { sku: 'S', asin: 'A' });
    db.seed('produtos/p', { nome: 'P' });
    db.exigirMascaraEm('prodAmazon');
    const [snap] = await db.getAll(link('p', 'l'), { fieldMask: ['sku'] });
    expect(snap?.data()).toEqual({ sku: 'S' });
    await expect(grupo().select('sku').get()).resolves.toMatchObject({ size: 0 });
    await expect(produtoRef('p').get()).resolves.toMatchObject({ exists: true });
    expect(() => db.exigirMascaraEm('produtos/p/prodAmazon')).toThrow(/sem barra/);
  });
});

describe('step 12 (12-e1): the operation counter', () => {
  it('★ counts documents read, getAll calls, queries and writes', async () => {
    db.seed('produtos/p', { nome: 'P', paiId: null });
    expect(db.contagem).toEqual({ leituras: 0, chamadasGetAll: 0, consultas: 0, escritas: 0 });
    await db.getAll(produtoRef('p'), produtoRef('q'), { fieldMask: ['nome'] });
    await produtoRef('p').get();
    await produtoCollection.ref(asDb(db), {}).where('paiId', '==', 'p').orderBy('nome').get();
    await produtoRef('p').update({ nome: 'Q' });
    expect(db.contagem).toEqual({ leituras: 3, chamadasGetAll: 1, consultas: 1, escritas: 1 });
    expect(db.operacoes).toBe(5);
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

describe('step 14 (14-c): ONE pedido’s nfev4 listing, whole, and a single precondition update', () => {
  const nfev4 = (pedidoId: string) => nfev4Collection.ref(asDb(db), { pedidoId });

  it('lists the pedido’s nfev4 documents — its own, never another pedido’s or a deeper one', async () => {
    db.seed('pedidos/p1/nfev4/s1', { estado: 'a' });
    db.seed('pedidos/p1/nfev4/s2', { estado: 'c' });
    db.seed('pedidos/p2/nfev4/s1', { estado: 'a' });
    db.seed('pedidos/p1/nfev4/s1/eventos/e1', { x: 1 });
    const snap = await nfev4('p1').get();
    expect(snap.docs.map((d) => [d.id, d.data()])).toEqual([
      ['s1', { estado: 'a' }],
      ['s2', { estado: 'c' }],
    ]);
    expect(db.consultas.at(-1)).toEqual({
      colecao: 'pedidos/p1/nfev4',
      filtros: [],
      ordens: [],
      limite: null,
      apos: null,
    });
  });

  it.each<[string, () => { get: () => Promise<unknown> }]>([
    ['a filter', () => nfev4('p1').where('estado', '==', 'a')],
    ['an order', () => nfev4('p1').orderBy('estado')],
    ['a limit', () => nfev4('p1').limit(1)],
    ['the collection group', () => nfev4Collection.groupQuery(asDb(db))],
    ['another subcollection', () => pagamentoCollection.ref(asDb(db), { pedidoId: 'p1' })],
  ])('NEAR-MISS: REFUSES %s', async (_c, montar) => {
    await expect(montar().get()).rejects.toThrow(/fora dos índices/);
  });

  it('a single update under lastUpdateTime lands on a fresh stamp and is refused 9 on a stale one', async () => {
    const stamp = db.seed('pedidos/p1', { a: 1 });
    await pedidoRef('p1').update({ a: 2 }, { lastUpdateTime: stamp as never });
    expect(db.ler('pedidos/p1')).toEqual({ a: 2 });
    expect(
      await codigoDe(pedidoRef('p1').update({ a: 3 }, { lastUpdateTime: stamp as never })),
    ).toBe(9);
  });
});

describe('step 12 (12-e1): ONE produto’s estoques partition, listed whole — shape 9', () => {
  const estoques = (produtoId: string) => estoqueCollection.ref(asDb(db), { produtoId });

  it('lists the produto’s own estoque rows, projected by select — never another produto’s or a deeper one', async () => {
    db.seed('produtos/p1/estoques/a', {
      depositoOuterRef: 'depositos/d1',
      quantidade: 3,
      extra: 1,
    });
    db.seed('produtos/p1/estoques/b', { depositoOuterRef: 'depositos/d2', quantidade: 4 });
    db.seed('produtos/p2/estoques/a', { depositoOuterRef: 'depositos/d1', quantidade: 9 });
    db.seed('produtos/p1/estoques/a/historico/h1', { x: 1 });
    const snap = await estoques('p1').select('depositoOuterRef', 'quantidade').get();
    expect(snap.docs.map((d) => [d.ref.path, d.data()])).toEqual([
      ['produtos/p1/estoques/a', { depositoOuterRef: 'depositos/d1', quantidade: 3 }],
      ['produtos/p1/estoques/b', { depositoOuterRef: 'depositos/d2', quantidade: 4 }],
    ]);
    expect(db.consultas.at(-1)).toEqual({
      colecao: 'produtos/p1/estoques',
      filtros: [],
      ordens: [],
      limite: null,
      apos: null,
      selecao: ['depositoOuterRef', 'quantidade'],
    });
  });

  it.each<[string, () => { get: () => Promise<unknown> }]>([
    ['a filter', () => estoques('p1').where('depositoOuterRef', '==', 'depositos/d1')],
    ['an order', () => estoques('p1').orderBy('quantidade')],
    ['a limit', () => estoques('p1').limit(1)],
    ['the collection group', () => estoqueCollection.groupQuery(asDb(db))],
  ])('NEAR-MISS: REFUSES %s', async (_c, montar) => {
    await expect(montar().get()).rejects.toThrow(/fora dos índices/);
  });
});

describe('step 12 (12-e2): the estoques movement window — shape 10', () => {
  const FORMA = 'documents/depositos/d1';
  const grupo = () => estoqueCollection.groupQuery(asDb(db));
  /** The window's exact shape: the depósito, both bounds, the stamp order and the key order. */
  const janela = (desde: number, ate: number) =>
    grupo()
      .where('depositoOuterRef', '==', FORMA)
      .where('ultimaModificacao', '>', desde)
      .where('ultimaModificacao', '<=', ate)
      .orderBy('ultimaModificacao')
      .orderBy('__name__');
  const caminhosDe = (snap: { docs: { ref: { path: string } }[] }) =>
    snap.docs.map((d) => d.ref.path);
  const linha = (caminho: string, ultimaModificacao: unknown) =>
    db.seed(caminho, { depositoOuterRef: FORMA, ultimaModificacao });

  it('★ runs the window: `>` EXCLUDES its bound and `<=` INCLUDES its bound (a NEAR-MISS pair at each edge)', async () => {
    linha('produtos/p1/estoques/a', 100);
    linha('produtos/p2/estoques/a', 101);
    linha('produtos/p3/estoques/a', 200);
    linha('produtos/p4/estoques/a', 201);
    const snap = await janela(100, 200).select('ultimaModificacao').limit(300).get();
    expect(caminhosDe(snap)).toEqual(['produtos/p2/estoques/a', 'produtos/p3/estoques/a']);
    expect(snap.docs.map((d) => d.data())).toEqual([
      { ultimaModificacao: 101 },
      { ultimaModificacao: 200 },
    ]);
    expect(db.consultas.at(-1)).toEqual({
      colecao: 'estoques',
      grupo: true,
      filtros: [
        ['depositoOuterRef', FORMA],
        ['ultimaModificacao >', 100],
        ['ultimaModificacao <=', 200],
      ],
      ordens: [
        ['ultimaModificacao', 'asc'],
        ['__name__', 'asc'],
      ],
      limite: 300,
      apos: null,
      selecao: ['ultimaModificacao'],
    });
  });

  it('★ a range never matches a null, a string or a missing stamp, nor another depósito’s row or another collection’s', async () => {
    linha('produtos/p1/estoques/a', null);
    linha('produtos/p2/estoques/a', '150');
    db.seed('produtos/p3/estoques/a', { depositoOuterRef: FORMA });
    db.seed('produtos/p4/estoques/a', { depositoOuterRef: 'depositos/d1', ultimaModificacao: 150 });
    linha('produtos/p5/historico/a', 150);
    linha('produtos/p6/estoques/a', 150);
    // Positive first: the one row that IS in the window comes back.
    expect(caminhosDe(await janela(100, 200).get())).toEqual(['produtos/p6/estoques/a']);
  });

  it('★ the KEY order is the full path segment by segment, and drops nothing (NEAR-MISS: the raw string order)', async () => {
    linha('produtos/a-b/estoques/x', 150);
    linha('produtos/a/estoques/x', 150);
    linha('produtos/a/estoques/w', 150);
    linha('produtos/0/estoques/z', 149);
    expect(caminhosDe(await janela(100, 200).get())).toEqual([
      'produtos/0/estoques/z',
      'produtos/a/estoques/w',
      'produtos/a/estoques/x',
      'produtos/a-b/estoques/x',
    ]);
    // The raw strings sort the other way round: `-` (0x2D) is below `/` (0x2F).
    expect('produtos/a-b/estoques/x' < 'produtos/a/estoques/x').toBe(true);
  });

  it('★ every query TIES on the document key, whatever the insertion order: a group query by its full path segment by segment, a collection query by its id', async () => {
    const grupoVinculos = () =>
      produtoAmazonLinkCollection
        .groupQuery(asDb(db))
        .where('contaAmazonOuterRef', 'in', ['c'])
        .where('sku', '==', 'S');
    for (const p of ['b', 'a-b', 'a']) {
      db.seed(`produtos/${p}/prodAmazon/l`, { contaAmazonOuterRef: 'c', sku: 'S' });
    }
    expect(caminhosDe(await grupoVinculos().get())).toEqual([
      'produtos/a/prodAmazon/l',
      'produtos/a-b/prodAmazon/l',
      'produtos/b/prodAmazon/l',
    ]);
    for (const id of ['z', 'm', 'a']) db.seed(`integracao/${id}`, { tipo: 8, nome: 'igual' });
    const snap = await contas().where('tipo', '==', 8).orderBy('nome').get();
    expect(snap.docs.map((d) => d.id)).toEqual(['a', 'm', 'z']);
  });

  it('★ startAfter(snapshot) on the GROUP query resumes exactly after the cursor, an equal stamp split by PATH; the log names the cursor’s full path', async () => {
    for (const p of ['p1', 'p2', 'p3']) linha(`produtos/${p}/estoques/a`, 150);
    linha('produtos/p0/estoques/a', 160);
    const base = janela(100, 200).select('ultimaModificacao').limit(2);
    const p1 = await base.get();
    expect(caminhosDe(p1)).toEqual(['produtos/p1/estoques/a', 'produtos/p2/estoques/a']);
    const cursor = p1.docs.at(-1);
    if (cursor === undefined) throw new Error('sem cursor');
    const p2 = await base.startAfter(cursor).get();
    expect(caminhosDe(p2)).toEqual(['produtos/p3/estoques/a', 'produtos/p0/estoques/a']);
    expect(db.consultas.at(-1)?.apos).toBe('produtos/p2/estoques/a');
    const ultimo = p2.docs.at(-1);
    if (ultimo === undefined) throw new Error('sem cursor');
    expect((await base.startAfter(ultimo).get()).empty).toBe(true);
    // ★ The counter counts each page as one query, and a query reads no document by id.
    expect(db.contagem).toEqual({ leituras: 0, chamadasGetAll: 0, consultas: 3, escritas: 0 });
  });

  it('★ NEAR-MISS: the group cursor refuses a hand-built snapshot, and one lacking the ordered stamp', async () => {
    linha('produtos/p1/estoques/a', 150);
    expect(() =>
      janela(100, 200).startAfter({
        id: 'a',
        ref: { path: 'produtos/p1/estoques/a' },
        data: () => ({ ultimaModificacao: 150 }),
      } as never),
    ).toThrow(/grupo/);
    const [doc] = (await janela(100, 200).select().get()).docs;
    if (doc === undefined) throw new Error('sem documento');
    // A keys-only snapshot holds no stamp to seek by.
    expect(() => janela(100, 200).startAfter(doc)).toThrow(/ultimaModificacao/);
  });

  it.each<[string, () => { get: () => Promise<unknown> }]>([
    [
      'an `in` over both ref forms',
      () =>
        grupo()
          .where('depositoOuterRef', 'in', [FORMA, 'depositos/d1'])
          .where('ultimaModificacao', '>', 1)
          .where('ultimaModificacao', '<=', 2)
          .orderBy('ultimaModificacao')
          .orderBy('__name__'),
    ],
    [
      'no upper bound',
      () =>
        grupo()
          .where('depositoOuterRef', '==', FORMA)
          .where('ultimaModificacao', '>', 1)
          .orderBy('ultimaModificacao')
          .orderBy('__name__'),
    ],
    [
      'no lower bound',
      () =>
        grupo()
          .where('depositoOuterRef', '==', FORMA)
          .where('ultimaModificacao', '<=', 2)
          .orderBy('ultimaModificacao')
          .orderBy('__name__'),
    ],
    [
      'no key order',
      () =>
        grupo()
          .where('depositoOuterRef', '==', FORMA)
          .where('ultimaModificacao', '>', 1)
          .where('ultimaModificacao', '<=', 2)
          .orderBy('ultimaModificacao'),
    ],
    [
      'a `<` upper bound',
      () =>
        grupo()
          .where('depositoOuterRef', '==', FORMA)
          .where('ultimaModificacao', '>', 1)
          .where('ultimaModificacao', '<', 2)
          .orderBy('ultimaModificacao')
          .orderBy('__name__'),
    ],
    [
      'the same shape on ONE produto’s partition (not a group query)',
      () =>
        estoqueCollection
          .ref(asDb(db), { produtoId: 'p1' })
          .where('depositoOuterRef', '==', FORMA)
          .where('ultimaModificacao', '>', 1)
          .where('ultimaModificacao', '<=', 2)
          .orderBy('ultimaModificacao')
          .orderBy('__name__'),
    ],
  ])('NEAR-MISS: REFUSES %s', async (_c, montar) => {
    await expect(montar().get()).rejects.toThrow(/fora dos índices/);
    expect(db.consultas).toEqual([]);
  });
});

describe('step 12 (12-e2): ONE produto’s prodAmazon partition, listed whole — shape 11', () => {
  const vinculos = (produtoId: string) => produtoAmazonLinkCollection.ref(asDb(db), { produtoId });

  it('★ lists the produto’s own link docs, projected by select — never another produto’s or a deeper one', async () => {
    db.seed('produtos/p1/prodAmazon/l1', {
      contaAmazonOuterRef: 'documents/integracao/c1',
      sku: 'S1',
      productDataJson: '{"grande":true}',
    });
    db.seed('produtos/p1/prodAmazon/l2', { contaAmazonOuterRef: 'integracao/c2', sku: 'S2' });
    db.seed('produtos/p2/prodAmazon/l1', { contaAmazonOuterRef: 'integracao/c1', sku: 'S9' });
    db.seed('produtos/p1/prodAmazon/l1/x/y', { sku: 'fundo' });
    const snap = await vinculos('p1').select('contaAmazonOuterRef', 'sku').get();
    expect(snap.docs.map((d) => [d.ref.path, d.data()])).toEqual([
      ['produtos/p1/prodAmazon/l1', { contaAmazonOuterRef: 'documents/integracao/c1', sku: 'S1' }],
      ['produtos/p1/prodAmazon/l2', { contaAmazonOuterRef: 'integracao/c2', sku: 'S2' }],
    ]);
    expect(db.consultas.at(-1)).toEqual({
      colecao: 'produtos/p1/prodAmazon',
      filtros: [],
      ordens: [],
      limite: null,
      apos: null,
      selecao: ['contaAmazonOuterRef', 'sku'],
    });
    expect(db.contagem).toEqual({ leituras: 0, chamadasGetAll: 0, consultas: 1, escritas: 0 });
  });

  it.each<[string, () => { get: () => Promise<unknown> }]>([
    ['a filter', () => vinculos('p1').where('contaAmazonOuterRef', '==', 'integracao/c1')],
    ['an order', () => vinculos('p1').orderBy('sku')],
    ['a limit', () => vinculos('p1').limit(1)],
    [
      'the conta filter as a GROUP query (a scan per row)',
      () =>
        produtoAmazonLinkCollection
          .groupQuery(asDb(db))
          .where('contaAmazonOuterRef', '==', 'integracao/c1'),
    ],
  ])('NEAR-MISS: REFUSES %s', async (_c, montar) => {
    await expect(montar().get()).rejects.toThrow(/fora dos índices/);
  });
});

describe('step 12 (12-f): the reconcile walk — shape 12, a KEY cursor from a reference', () => {
  const grupo = () => produtoAmazonLinkCollection.groupQuery(asDb(db));
  const refVinculo = (produtoId: string, linkId: string) =>
    produtoAmazonLinkCollection.docRef(asDb(db), { produtoId }, linkId);

  beforeEach(() => {
    db.seed('produtos/b/prodAmazon/l1', { contaAmazonOuterRef: 'integracao/c1', sku: 'B' });
    db.seed('produtos/a-b/prodAmazon/l1', { contaAmazonOuterRef: 'integracao/c1', sku: 'AB' });
    db.seed('produtos/a/prodAmazon/l2', { contaAmazonOuterRef: 'integracao/c1', sku: 'A2' });
    db.seed('produtos/a/prodAmazon/l1', { contaAmazonOuterRef: 'integracao/c1', sku: 'A1' });
    db.seed('produtos/c/prodAmazon/l1', { contaAmazonOuterRef: 'integracao/c2', sku: 'OUTRA' });
  });

  it('★ runs `contaAmazonOuterRef ==` · orderBy(__name__) · limit in KEY order, and resumes EXACTLY after a reference cursor', async () => {
    const primeira = await grupo()
      .where('contaAmazonOuterRef', '==', 'integracao/c1')
      .orderBy('__name__')
      .select('sku')
      .limit(2)
      .get();
    expect(primeira.docs.map((d) => [d.ref.path, d.data()])).toEqual([
      ['produtos/a/prodAmazon/l1', { sku: 'A1' }],
      ['produtos/a/prodAmazon/l2', { sku: 'A2' }],
    ]);
    const segunda = await grupo()
      .where('contaAmazonOuterRef', '==', 'integracao/c1')
      .orderBy('__name__')
      .startAfter(refVinculo('a', 'l2') as never)
      .select('sku')
      .limit(2)
      .get();
    expect(segunda.docs.map((d) => d.ref.path)).toEqual([
      'produtos/a-b/prodAmazon/l1',
      'produtos/b/prodAmazon/l1',
    ]);
    expect(db.consultas.at(-1)).toMatchObject({
      colecao: 'prodAmazon',
      grupo: true,
      filtros: [['contaAmazonOuterRef', 'integracao/c1']],
      ordens: [['__name__', 'asc']],
      limite: 2,
      apos: 'produtos/a/prodAmazon/l2',
      selecao: ['sku'],
    });
  });

  it('★ a reference cursor resumes after a doc that NO LONGER exists, by its key', async () => {
    const snap = await grupo()
      .where('contaAmazonOuterRef', '==', 'integracao/c1')
      .orderBy('__name__')
      .startAfter(refVinculo('a', 'l15') as never)
      .limit(10)
      .get();
    expect(snap.docs.map((d) => d.ref.path)).toEqual([
      'produtos/a/prodAmazon/l2',
      'produtos/a-b/prodAmazon/l1',
      'produtos/b/prodAmazon/l1',
    ]);
  });

  it.each<[string, () => { get: () => Promise<unknown> }]>([
    [
      'an `in` over the ref forms',
      () => grupo().where('contaAmazonOuterRef', 'in', ['integracao/c1']).orderBy('__name__'),
    ],
    ['no key order', () => grupo().where('contaAmazonOuterRef', '==', 'integracao/c1')],
    [
      'another order before the key',
      () =>
        grupo()
          .where('contaAmazonOuterRef', '==', 'integracao/c1')
          .orderBy('sku')
          .orderBy('__name__'),
    ],
  ])('NEAR-MISS: REFUSES %s', async (_c, montar) => {
    await expect(montar().get()).rejects.toThrow(/fora dos índices/);
  });

  it('NEAR-MISS: a reference cursor under any order but the key alone, or a reference no fake built, is refused', () => {
    expect(() =>
      grupo()
        .where('contaAmazonOuterRef', '==', 'integracao/c1')
        .orderBy('sku')
        .startAfter(refVinculo('a', 'l1') as never),
    ).toThrow(/orderBy\(__name__\)/);
    expect(() =>
      grupo()
        .where('contaAmazonOuterRef', '==', 'integracao/c1')
        .startAfter(refVinculo('a', 'l1') as never),
    ).toThrow(/orderBy\(__name__\)/);
    expect(() =>
      grupo()
        .where('contaAmazonOuterRef', '==', 'integracao/c1')
        .orderBy('__name__')
        .startAfter({ id: 'l1', path: 'produtos/a/prodAmazon/l1' } as never),
    ).toThrow();
  });
});

describe('step 12 (12-f): stored stamps', () => {
  it('★ a stamp stored as a field (a read’s readTime) reads back as a LIVE stamp of the same instant', async () => {
    const lido = await ref('a').get();
    const relogio = lido.readTime;
    await ref('a').create({ relogio, outro: { dentro: relogio }, lista: [relogio] });
    const dados = (await ref('a').get()).data() as Record<string, unknown>;
    const guardado = dados.relogio as { isEqual: (o: unknown) => boolean; toMillis: () => number };
    expect(guardado.isEqual(relogio)).toBe(true);
    expect(guardado.toMillis()).toBe(relogio.toMillis());
    expect(guardado).not.toBe(relogio);
    expect(
      (
        (dados.outro as Record<string, unknown>).dentro as { isEqual: (o: unknown) => boolean }
      ).isEqual(relogio),
    ).toBe(true);
    expect(
      ((dados.lista as unknown[])[0] as { isEqual: (o: unknown) => boolean }).isEqual(relogio),
    ).toBe(true);
  });

  it('a stored stamp’s copy is detached (mutating a read changes nothing), and a Date stays a Date', async () => {
    const data = new Date(Date.UTC(2027, 0, 1));
    await ref('a').create({ quando: data });
    const lido = (await ref('a').get()).data() as Record<string, unknown>;
    expect(lido.quando).toBeInstanceOf(Date);
    expect((lido.quando as Date).getTime()).toBe(data.getTime());
    expect(lido.quando).not.toBe(data);
  });

  it('NEAR-MISS: a function anywhere else in a payload is still refused, as the SDK refuses it', async () => {
    await expect(Promise.resolve().then(() => ref('a').create({ f: () => 1 }))).rejects.toThrow();
  });

  it('two stored stamps of one instant are the same content: a batch carrier re-writing one keeps the doc’s stamp', async () => {
    const lido = await ref('a').get();
    db.seed(CAMINHO, { relogio: lido.readTime });
    const antes = db.carimboDe(CAMINHO);
    const [r] = await db
      .batch()
      .update(ref('a'), { relogio: lido.readTime }, { lastUpdateTime: antes })
      .commit();
    expect(r?.writeTime).toBe(antes);
    expect(db.carimboDe(CAMINHO)).toBe(antes);
  });
});

/* -------------------------------------------------------------------------- */
/*          step 13 (PR 13-b): a map's ONE entry as a two-segment mask         */
/* -------------------------------------------------------------------------- */

describe('step 13 (13-b): getAll with a two-segment FieldPath mask', () => {
  /** Three tabelas' entries, a dotted id beside its NESTED look-alike, a label and a flag. */
  const PRODUTO = {
    nome: 'P',
    propagatePriceToChildren: true,
    precos: {
      normal: { valor: 10 },
      'pro.mo': { valor: 8 },
      outra: { valor: 99 },
      pro: { mo: { valor: 1 } },
    },
  };

  it('★ projects { [mapa]: { [chave]: … } } with ONLY the asked entries — a dotted chave is ONE key, never its nested look-alike', async () => {
    db.seed('produtos/p', PRODUTO);
    const [snap] = await db.getAll(produtoRef('p'), {
      fieldMask: [new FieldPath('precos', 'normal'), new FieldPath('precos', 'pro.mo')],
    });
    expect(snap?.data()).toEqual({ precos: { normal: { valor: 10 }, 'pro.mo': { valor: 8 } } });
    expect(Object.keys((snap?.data()?.precos ?? {}) as object).sort()).toEqual([
      'normal',
      'pro.mo',
    ]);
    expect(snap?.data()?.nome).toBeUndefined();
  });

  it('★ beside top-level names: each kept; a top-level name of the SAME map answers the whole map', async () => {
    db.seed('produtos/p', PRODUTO);
    const [a] = await db.getAll(produtoRef('p'), {
      fieldMask: [new FieldPath('precos', 'normal'), 'propagatePriceToChildren'],
    });
    expect(a?.data()).toEqual({
      precos: { normal: { valor: 10 } },
      propagatePriceToChildren: true,
    });
    const [b] = await db.getAll(produtoRef('p'), {
      fieldMask: [new FieldPath('precos', 'normal'), 'precos'],
    });
    expect(b?.data()).toEqual({ precos: PRODUTO.precos });
    const [c] = await db.getAll(produtoRef('p'), {
      fieldMask: ['precos', new FieldPath('precos', 'normal')],
    });
    expect(c?.data()).toEqual({ precos: PRODUTO.precos });
  });

  it('an entry the map lacks, a map that is not a map, a document without the map: nothing of the map comes back', async () => {
    db.seed('produtos/p', PRODUTO);
    db.seed('produtos/q', { nome: 'Q', precos: 7 });
    db.seed('produtos/r', { nome: 'R' });
    const snaps = await db.getAll(produtoRef('p'), produtoRef('q'), produtoRef('r'), {
      fieldMask: [new FieldPath('precos', 'ausente')],
    });
    expect(snaps.map((s) => s.data())).toEqual([{}, {}, {}]);
    expect(snaps.map((s) => s.exists)).toEqual([true, true, true]);
  });

  it('★ NEAR-MISS: a top-level dotted STRING is still refused, exactly as before (a server reads it as a path)', () => {
    expect(() => db.getAll(produtoRef('p'), { fieldMask: ['precos.normal'] })).toThrow(
      /primeiro nível/,
    );
  });

  it('refuses a FieldPath of any other length, and a FieldPath in a query select', () => {
    expect(() => db.getAll(produtoRef('p'), { fieldMask: [new FieldPath('precos')] })).toThrow(
      /dois segmentos/,
    );
    expect(() =>
      db.getAll(produtoRef('p'), { fieldMask: [new FieldPath('precos', 'a', 'b')] }),
    ).toThrow(/dois segmentos/);
    expect(() =>
      produtoAmazonLinkCollection.groupQuery(asDb(db)).select(new FieldPath('a', 'b') as never),
    ).toThrow(/primeiro nível/);
    expect(db.leituras).toEqual([]);
  });

  it('★ the log records the entry as its pair, and every counter moves exactly as for a top-level mask', async () => {
    db.seed('produtos/p', PRODUTO);
    await db.getAll(produtoRef('p'), produtoRef('q'), {
      fieldMask: [new FieldPath('precos', 'pro.mo'), 'nome'],
    });
    expect(db.leiturasDetalhadas).toEqual([
      { caminho: 'produtos/p', via: 'getAll', chamada: 1, mascara: [['precos', 'pro.mo'], 'nome'] },
      { caminho: 'produtos/q', via: 'getAll', chamada: 1, mascara: [['precos', 'pro.mo'], 'nome'] },
    ]);
    expect(db.contagem).toEqual({ leituras: 2, chamadasGetAll: 1, consultas: 0, escritas: 0 });
  });

  it('a nested-only mask satisfies a collection that refuses unmasked reads; the snapshot keeps exists and updateTime', async () => {
    const carimbo = db.seed('produtos/p', PRODUTO);
    db.exigirMascaraEm('produtos');
    const [snap] = await db.getAll(produtoRef('p'), {
      fieldMask: [new FieldPath('precos', 'outra')],
    });
    expect(snap?.data()).toEqual({ precos: { outra: { valor: 99 } } });
    expect(snap?.updateTime?.isEqual(carimbo)).toBe(true);
    // The stored document is untouched by the projection.
    expect(db.ler('produtos/p')).toEqual(PRODUTO);
  });
});

describe('step 13 (13-b): a two-segment mask, its near-misses', () => {
  it('★ NEAR-MISS: an ARRAY is no map — a two-segment mask over it returns nothing of it', async () => {
    db.seed('produtos/p', { nome: 'P', precos: [{ valor: 1 }] });
    const [snap] = await db.getAll(produtoRef('p'), { fieldMask: [new FieldPath('precos', '0')] });
    expect(snap?.data()).toEqual({});
  });

  it('★ the fake loads no value of the SDK: a suite that mocks firebase-admin/firestore WITHOUT FieldPath still masks by plain names', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('firebase-admin/firestore', () => ({ FieldValue: {} }));
    try {
      const { FakeDb: FakeIsolada, asDb: asDbIsolada } = await import('./fakeDb');
      const isolada = new FakeIsolada();
      isolada.seed('produtos/p', { nome: 'P', outro: 1 });
      const ref = produtoCollection.docRef(asDbIsolada(isolada), {}, 'p');
      const [snap] = await isolada.getAll(ref, { fieldMask: ['nome'] });
      expect(snap?.data()).toEqual({ nome: 'P' });
    } finally {
      vi.doUnmock('firebase-admin/firestore');
      vi.resetModules();
    }
  });
});
