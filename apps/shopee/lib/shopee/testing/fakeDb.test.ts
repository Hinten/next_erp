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
import { describe, expect, it } from 'vitest';

import { pedidoCollection } from '@delfrance/data/admin/collections';

import { FakeDb, asDb } from './fakeDb';

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
