/**
 * The double's OWN suite, added by step 8 (#1516).
 *
 * Every other suite in this app drives `FakeDb` through a module under test, so
 * what it can observe is that module's behaviour — and while the query builder
 * silently dropped the operator, an `in` or a `<` answered "matches nothing" and
 * those suites all read GREEN. That is why this file exists, and it pins ONLY
 * what step 8 added: the operators, the ordering, the cursor, the chainable
 * `limit` and the second query log. The pre-existing behaviour stays pinned
 * where it always was — by the nineteen suites that drive it.
 *
 * The queries go through `pedidoCollection.ref()` like every caller does (raw
 * `.collection()` is lint-banned in this app), but nothing here is about the
 * pedido schema: the handle supplies a PATH, the double stores and answers raw
 * data, and the subject is the query engine.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { avisoCollection, pedidoCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition } from '@delfrance/data/admin';

import { FakeDb, arrayUnion, asDb, grpc } from './fakeDb';

/** The ids a chain answers, in the order it answered them. */
async function idsDe(consulta: {
  get(): Promise<{ docs: readonly { id: string }[] }>;
}): Promise<string[]> {
  const snap = await consulta.get();
  return snap.docs.map((d) => d.id);
}

function comValores(): { db: FakeDb; pedidos: () => ReturnType<typeof pedidoCollection.ref> } {
  const db = new FakeDb();
  db.seed('pedidos/a', { timestamp: 10, estado: 'x' });
  db.seed('pedidos/b', { timestamp: 20, estado: 'y' });
  db.seed('pedidos/c', { timestamp: 30 }); // sem `estado` — o campo AUSENTE
  db.seed('pedidos/d', { timestamp: '25' }); // o mesmo número como STRING (o corpus legado)
  return { db, pedidos: () => pedidoCollection.ref(asDb(db), {}) };
}

/** Insertion order is the tie-break the stable sort must preserve. */
function comOrdem(): { db: FakeDb; pedidos: () => ReturnType<typeof pedidoCollection.ref> } {
  const db = new FakeDb();
  db.seed('pedidos/p1', { timestamp: 100, estado: 'b' });
  db.seed('pedidos/p2', { timestamp: 300, estado: 'a' });
  db.seed('pedidos/p3', { timestamp: 200, estado: 'b' });
  db.seed('pedidos/p4', { timestamp: 200, estado: 'a' });
  db.seed('pedidos/p5', { estado: 'z' }); // sem `timestamp`
  db.seed('pedidos/p6', { timestamp: null, estado: 'z' }); // `timestamp` nulo
  return { db, pedidos: () => pedidoCollection.ref(asDb(db), {}) };
}

describe('FakeDb — falhasDeUpdate', () => {
  it('recusa o update de UM caminho e deixa os outros em paz', async () => {
    const db = new FakeDb();
    const avisos = avisoCollection.resolvePath({});
    db.seed(`${avisos}/um`, { resolvidoEm: null });
    db.seed(`${avisos}/dois`, { resolvidoEm: null });
    db.falhasDeUpdate.set(`${avisos}/um`, grpc(9, 'FAILED_PRECONDITION'));

    await expect(
      avisoCollection.docRef(asDb(db), {}, 'um').update({ resolvidoEm: 1 }),
    ).rejects.toMatchObject({ code: 9 });
    await avisoCollection.docRef(asDb(db), {}, 'dois').update({ resolvidoEm: 2 });

    // A recusa acontece ANTES da escrita: o documento não se move e nada entra
    // em `writes`, que é o que torna "ninguém escreveu" asserível — e é o que
    // deixa `resolverAviso` responder `false` sem ter escrito.
    expect(db.store[`${avisos}/um`]!.data.resolvidoEm).toBeNull();
    expect(db.store[`${avisos}/dois`]!.data.resolvidoEm).toBe(2);
    expect(db.writes.map((w) => w.path)).toEqual([`${avisos}/dois`]);
  });
});

describe('FakeDb — where', () => {
  it('where honra o operador: ==, in, <, <=, >, >=, !=', async () => {
    const { pedidos } = comValores();

    expect(await idsDe(pedidos().where('timestamp', '==', 20))).toEqual(['b']);
    expect(await idsDe(pedidos().where('timestamp', 'in', [10, 30]))).toEqual(['a', 'c']);
    expect(await idsDe(pedidos().where('timestamp', '<', 25))).toEqual(['a', 'b']);
    expect(await idsDe(pedidos().where('timestamp', '<=', 20))).toEqual(['a', 'b']);
    expect(await idsDe(pedidos().where('timestamp', '>', 20))).toEqual(['c']);
    expect(await idsDe(pedidos().where('timestamp', '>=', 20))).toEqual(['b', 'c']);

    // ⚠️ Um campo AUSENTE não casa com NADA — nem com `!=`, que é a regra do
    // Firestore e não a do JavaScript. `c` e `d` não têm `estado`.
    expect(await idsDe(pedidos().where('estado', '!=', 'x'))).toEqual(['b']);
    expect(await idsDe(pedidos().where('estado', '==', 'x'))).toEqual(['a']);
    expect(await idsDe(pedidos().where('estado', 'in', ['x', 'y']))).toEqual(['a', 'b']);
  });

  it('não compara entre TIPOS: 25 e "25" são valores diferentes', async () => {
    const { pedidos } = comValores();

    // `d` guarda `'25'`. Nenhuma desigualdade numérica o alcança…
    expect(await idsDe(pedidos().where('timestamp', '<', 100))).toEqual(['a', 'b', 'c']);
    expect(await idsDe(pedidos().where('timestamp', '>=', 0))).toEqual(['a', 'b', 'c']);
    // …e a igualdade só o alcança pela string.
    expect(await idsDe(pedidos().where('timestamp', '==', '25'))).toEqual(['d']);
    expect(await idsDe(pedidos().where('timestamp', 'in', ['25']))).toEqual(['d']);
  });

  it('um operador desconhecido LANÇA', async () => {
    const { pedidos } = comValores();

    // Não é um `===` silencioso: um operador que ninguém ensinou chega como
    // FALHA, e não como uma consulta que não casa com nada.
    await expect(idsDe(pedidos().where('itens', 'array-contains', 'x'))).rejects.toThrow(
      /array-contains/,
    );
  });
});

describe('FakeDb — orderBy, startAfter e limit', () => {
  it('orderBy ordena (asc/desc, estável, nulos por último) e startAfter pula até o id inclusive', async () => {
    const { pedidos } = comOrdem();

    expect(await idsDe(pedidos().orderBy('timestamp', 'desc'))).toEqual([
      'p2',
      'p3',
      'p4',
      'p1',
      'p5',
      'p6',
    ]);
    expect(await idsDe(pedidos().orderBy('timestamp', 'asc'))).toEqual([
      'p1',
      'p3',
      'p4',
      'p2',
      'p5',
      'p6',
    ]);

    // ESTÁVEL: p3 e p4 empatam em `timestamp` e saem na ordem de inserção acima;
    // com uma SEGUNDA chave o empate é desfeito por ela, não pela inserção.
    expect(await idsDe(pedidos().orderBy('timestamp', 'asc').orderBy('estado', 'asc'))).toEqual([
      'p1',
      'p4',
      'p3',
      'p2',
      'p5',
      'p6',
    ]);

    // O cursor é de DOCUMENTO: tudo até o id, inclusive, sai.
    expect(await idsDe(pedidos().orderBy('timestamp', 'desc').startAfter({ id: 'p3' }))).toEqual([
      'p4',
      'p1',
      'p5',
      'p6',
    ]);
    // E o corte vem DEPOIS do cursor, nunca antes.
    expect(
      await idsDe(pedidos().orderBy('timestamp', 'desc').startAfter({ id: 'p3' }).limit(2)),
    ).toEqual(['p4', 'p1']);
  });

  it('startAfter com um id fora do resultado LANÇA', async () => {
    const { pedidos } = comOrdem();

    await expect(
      idsDe(pedidos().where('timestamp', '==', 100).startAfter({ id: 'p2' })),
    ).rejects.toThrow(/startAfter/);
  });

  it('limit devolve a cadeia', async () => {
    const { pedidos } = comOrdem();

    // Antes do passo 8 `limit()` devolvia só `{ get }`, então nada podia vir
    // depois dele. A ordem das chamadas deixou de importar…
    expect(await idsDe(pedidos().limit(2).orderBy('timestamp', 'desc'))).toEqual(['p2', 'p3']);
    // …e o caminho antigo `.limit(n).get()` continua exatamente igual.
    expect(await idsDe(pedidos().limit(3))).toEqual(['p1', 'p2', 'p3']);
  });
});

/* -------------------------------------------------------------------------- */
/*  As três adições do passo 9 (#1517)                                         */
/* -------------------------------------------------------------------------- */

describe('FakeDb — o sentinela de arrayUnion', () => {
  it('aplica a união na escrita: acrescenta em ORDEM e não duplica', async () => {
    const db = new FakeDb();
    db.seed('pedidos/a', { tags: ['x'] });
    const ref = pedidoCollection.docRef(asDb(db), {}, 'a');

    await ref.update({ tags: arrayUnion('y', 'x', 'z') } as never);

    // `x` já estava lá e não entra de novo; `y` e `z` entram na ordem em que
    // foram passados. É a semântica do Firestore, não a de um `concat`.
    expect(db.store['pedidos/a']!.data.tags).toEqual(['x', 'y', 'z']);
    // ⚠️ E o registro de patches continua provando qual SENTINELA foi escrito —
    // um read-modify-write não produziria essa linha.
    expect(db.patches.at(-1)!.patch.tags).toEqual({ __arrayUnion: ['y', 'x', 'z'] });
  });

  it('aplica também o FieldValue.arrayUnion REAL — é o que putArquivoAdmin escreve', async () => {
    const db = new FakeDb();
    db.seed('pedidos/a', {});
    const ref = pedidoCollection.docRef(asDb(db), {}, 'a');

    await ref.update({
      externalIds: FieldValue.arrayUnion({
        externalId: 'img-1',
        integracaoPath: 'integracao/int-1',
      }),
    } as never);
    await ref.update({
      externalIds: FieldValue.arrayUnion({
        externalId: 'img-1',
        integracaoPath: 'integracao/int-1',
      }),
    } as never);

    // Duas importações do mesmo `image_id` deixam UMA entrada — se o dobro
    // sobrevivesse, toda asserção de dedup de foto passaria sem dedup nenhum.
    expect(db.store['pedidos/a']!.data.externalIds).toEqual([
      { externalId: 'img-1', integracaoPath: 'integracao/int-1' },
    ]);
  });

  it('⛔ NEAR-MISS: a união não dobra tipos — "1" e 1, e 0 e null, continuam distintos', async () => {
    const db = new FakeDb();
    db.seed('pedidos/a', { ids: [1] });
    const ref = pedidoCollection.docRef(asDb(db), {}, 'a');

    await ref.update({ ids: arrayUnion('1', 0, null) } as never);

    // Um corpus legado guarda o mesmo id como STRING; dobrá-lo aqui reportaria
    // um vínculo corrompido como "já presente" e ele ficaria sem apontar para
    // nada para sempre.
    expect(db.store['pedidos/a']!.data.ids).toEqual([1, '1', 0, null]);
  });

  it('⛔ NEAR-MISS: objetos com chaves em ORDEM diferente são o MESMO elemento', async () => {
    const db = new FakeDb();
    db.seed('pedidos/a', { refs: [{ a: 1, b: 2 }] });
    const ref = pedidoCollection.docRef(asDb(db), {}, 'a');

    await ref.update({ refs: arrayUnion({ b: 2, a: 1 }, { a: 1, b: 3 }) } as never);

    // A ordem das chaves não é um fato do documento — o Firestore não a usa para
    // decidir igualdade, e um dedup por `JSON.stringify` diria que são dois.
    expect(db.store['pedidos/a']!.data.refs).toEqual([
      { a: 1, b: 2 },
      { a: 1, b: 3 },
    ]);
  });
});

describe('FakeDb — caminhos pontilhados no update', () => {
  it('expande a.b.c em objetos aninhados', async () => {
    const db = new FakeDb();
    db.seed('pedidos/a', {});
    await pedidoCollection
      .docRef(asDb(db), {}, 'a')
      .update({ 'precos.tabela-1.valor': 10 } as never);

    expect(db.store['pedidos/a']!.data).toEqual({ precos: { 'tabela-1': { valor: 10 } } });
  });

  it('⛔ NEAR-MISS: um campo IRMÃO sobrevive ao update pontilhado', async () => {
    const db = new FakeDb();
    db.seed('pedidos/a', { precos: { normal: 10, promocional: 8 }, nome: 'x' });

    await pedidoCollection.docRef(asDb(db), {}, 'a').update({ 'precos.normal': 12 } as never);

    // É o motivo de a escrita de preço nomear UMA chave de tabela: a tabela
    // irmã (e o mapa `precos` legado inteiro) não pode ser tocada. Um `update`
    // que substituísse `precos` passaria em tudo, menos aqui.
    expect(db.store['pedidos/a']!.data.precos).toEqual({ normal: 12, promocional: 8 });
    expect(db.store['pedidos/a']!.data.nome).toBe('x');
  });

  it('o registro de patches guarda a chave PONTILHADA, não a expandida', async () => {
    const db = new FakeDb();
    db.seed('pedidos/a', {});
    await pedidoCollection.docRef(asDb(db), {}, 'a').update({ 'precos.t1': 1 } as never);
    expect(db.patches.at(-1)!.patch).toEqual({ 'precos.t1': 1 });
  });

  it('⛔ NEAR-MISS: em set/create a chave pontilhada é um NOME de campo, não um caminho', async () => {
    // A regra é do Firestore, não uma conveniência do dobro: só os verbos de
    // update expandem. Um dobro que expandisse em `set` esconderia um `set` que
    // na produção criaria literalmente um campo chamado "a.b".
    const db = new FakeDb();
    await pedidoCollection.docRef(asDb(db), {}, 'a').set({ 'a.b': 1 } as never);
    expect(db.store['pedidos/a']!.data).toEqual({ 'a.b': 1 });
  });
});

describe('FakeDb — updateTime e a precondição lastUpdateTime', () => {
  it('toda leitura traz um carimbo, e uma escrita bem-sucedida o AVANÇA', async () => {
    const db = new FakeDb();
    db.seed('pedidos/a', { n: 1 });
    const ref = pedidoCollection.docRef(asDb(db), {}, 'a');

    const antes = await ref.get();
    await ref.update({ n: 2 } as never);
    const depois = await ref.get();

    expect(antes.updateTime).toBeDefined();
    expect(depois.updateTime!.isEqual(antes.updateTime!)).toBe(false);
    // O mesmo carimbo é igual a si mesmo — `isEqual`, nunca `===`: dois
    // Timestamps reais iguais são INSTÂNCIAS diferentes.
    expect(depois.updateTime!.isEqual(depois.updateTime!)).toBe(true);
  });

  it('a consulta também devolve o carimbo de cada linha', async () => {
    const db = new FakeDb();
    db.seed('pedidos/a', { estado: 'x' });
    const snap = await pedidoCollection.ref(asDb(db), {}).where('estado', '==', 'x').get();
    expect(snap.docs[0]!.updateTime).toBeDefined();
  });

  it('um update com o carimbo FRESCO passa', async () => {
    const db = new FakeDb();
    db.seed('pedidos/a', { n: 1 });
    const ref = pedidoCollection.docRef(asDb(db), {}, 'a');
    const snap = await ref.get();

    await ref.update({ n: 2 } as never, { lastUpdateTime: snap.updateTime! });
    expect(db.store['pedidos/a']!.data.n).toBe(2);
  });

  it('⛔ NEAR-MISS: um carimbo VELHO é recusado com um erro que isFailedPrecondition reconhece', async () => {
    const db = new FakeDb();
    db.seed('pedidos/a', { n: 1 });
    const ref = pedidoCollection.docRef(asDb(db), {}, 'a');
    const snap = await ref.get();

    // Um segundo escritor passa na frente…
    await ref.update({ n: 99 } as never);

    // …e o patch derivado da leitura antiga NÃO entra. Sem esta recusa a
    // escrita guardada degrada para uma escrita sem guarda em TODO teste, e o
    // perdedor sobrescreve o vencedor em silêncio.
    const erro = await ref.update({ n: 2 } as never, { lastUpdateTime: snap.updateTime! }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).not.toBeNull();
    expect(isFailedPrecondition(erro)).toBe(true);
    expect(db.store['pedidos/a']!.data.n).toBe(99);
    // E nada foi escrito: a recusa acontece ANTES da escrita.
    expect(db.writes.filter((w) => w.path === 'pedidos/a')).toHaveLength(1);
  });

  it('⛔ NEAR-MISS: um carimbo que não é carimbo NENHUM é recusado, não ignorado', async () => {
    const db = new FakeDb();
    db.seed('pedidos/a', { n: 1 });
    // Passar um número (o formato ANTIGO deste dobro) não pode valer "sem
    // precondição": isso faria uma escrita guardada virar uma sem guarda.
    const erro = await pedidoCollection
      .docRef(asDb(db), {}, 'a')
      .update({ n: 2 } as never, { lastUpdateTime: 101 as never })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isFailedPrecondition(erro)).toBe(true);
  });
});

describe('FakeDb — os dois registros de consulta', () => {
  it('consultasCompletas registra a consulta inteira e consultas continua igual', async () => {
    const { db, pedidos } = comOrdem();

    await pedidos()
      .where('timestamp', '>', 150)
      .orderBy('timestamp', 'desc')
      .startAfter({ id: 'p3' })
      .limit(2)
      .get();

    expect(db.consultasCompletas).toEqual([
      {
        fonte: 'pedidos',
        clausulas: [['timestamp', '>', 150]],
        ordens: [['timestamp', 'desc']],
        limite: 2,
        apos: 'p3',
      },
    ]);

    // ⚠️ O registro ANTIGO não mudou: três chaves, cláusulas em PARES. Três
    // suítes o comparam por valor (o cabeçalho de `fakeDb.ts` nomeia as três),
    // e uma delas desestrutura `[campo]` / `[, valor]` — numa tripla isso leria
    // o OPERADOR como valor.
    expect(db.consultas).toEqual([
      { fonte: 'pedidos', clausulas: [['timestamp', 150]], limite: 2 },
    ]);
  });
});
