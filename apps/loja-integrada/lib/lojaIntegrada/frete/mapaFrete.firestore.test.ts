/**
 * The freight `mapa` registration on a real Firestore — the emulator of `ci-loja-integrada.yml`,
 * not the in-memory fake.
 *
 * The offline suite (`mapaFrete.test.ts`) proves the decisions against `testing/fakeDb.ts`, which
 * MODELS how the server applies the two primitives the helper rests on: `arrayUnion` and the
 * `lastUpdateTime` precondition. This file proves the model, both halves of the union and the
 * precondition:
 *
 *  - the union onto a `null`, an absent and an existing array: the stored rows come back
 *    untouched, the new row last;
 *  - the union's dedup: the server and the fake answer one union with the same array — the same
 *    key set in another order is one value, a number is not its string, `0` is not `null`, and a
 *    duplicate inside one call lands once;
 *  - two registrations of ONE new key, both past their read before either writes
 *    (`Promise.all`, held at a barrier): exactly one row lands, and the loser's write fails 9;
 *  - a raw `update(…, { lastUpdateTime })` on a DELETED doc fails (9, or 5) and never
 *    resurrects it. The helper-level "removed between the read and the write" case stays in the
 *    fake suite: the helper's deps give no seam to delete mid-call, and none is added;
 *  - a `mapa` that is a map is left exactly as it was.
 *
 * ⚠️ It seeds `int_frete` directly, never an `integracao` doc, and every back-ref names a conta id
 * no other suite seeds, so nothing here can meet another file's rows. Its `beforeEach` deletes
 * exactly the docs it reads.
 */
import { env } from 'node:process';
import {
  type DocumentData,
  type DocumentReference,
  FieldValue,
  type Firestore,
  type Timestamp,
  type WriteResult,
} from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isFailedPrecondition,
  isGrpcStatusError,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { FakeDb, arrayUnion as uniaoDoFake } from '../testing/fakeDb';
import { type MapaFreteDeps, registrarFormaEnvioNoMapaLi } from './mapaFrete';

const EMULATED = Boolean(env.FIRESTORE_EMULATOR_HOST);

const INT_FRETE = 'int_frete';

/** Obviously fake conta ids, distinct from every other emulator suite's. */
const CONTAS = {
  nulo: 'conta-li-mapa-ci-nulo',
  ausente: 'conta-li-mapa-ci-ausente',
  lista: 'conta-li-mapa-ci-lista',
  corrida: 'conta-li-mapa-ci-corrida',
  removido: 'conta-li-mapa-ci-removido',
  mapa: 'conta-li-mapa-ci-mapa',
  uniao: 'conta-li-mapa-ci-uniao',
} as const;

const PAC = { id: 141909, code: 'PAC', nome: 'Gateway A', tipo: 'Transportadora' } as const;

const deps: MapaFreteDeps = { arrayUnion: (...e: unknown[]) => FieldValue.arrayUnion(...e) };

function db(): Firestore {
  return getAdminFirestore();
}

function idFrete(conta: string): string {
  return `lojaIntegrada-${conta}`;
}

function refFrete(conta: string): DocumentReference {
  return db().collection(INT_FRETE).doc(idFrete(conta));
}

/** The conta's freight doc as the core leaves it, with `over` on top. */
function docFrete(conta: string, over: DocumentData = {}): DocumentData {
  return {
    tipo: 'lojaIntegrada',
    nome: 'Loja de teste',
    ativo: true,
    contaLojaIntegradaEnviosOuterRef: `documents/integracao/${conta}`,
    filialIntegracaoFreteOuterRef: 'documents/filiais/f1',
    dataCadastro: 1,
    ultimaModificacao: 1,
    ...over,
  };
}

/** The 7-key row the importer appends, written out by hand. */
function linha(idOriginal: string, numero: number): DocumentData {
  return {
    nomeOriginal: 'Gateway A - Transportadora',
    idOriginal,
    observacao: `Origem: Pedido ${String(numero)}`,
    nomeTarget: null,
    targetData: null,
    integracaoUid: null,
    targetTipoIntegracao: 'outros',
  };
}

function registrar(conta: string, numero: number, banco: Firestore = db()) {
  return registrarFormaEnvioNoMapaLi(
    banco,
    { integracaoId: conta, intFreteId: idFrete(conta), formaEnvio: PAC, numero },
    deps,
  );
}

/** A snapshot's commit stamp — present on every snapshot of an existing document. */
function carimbo(snap: { readonly updateTime?: Timestamp; readonly ref: DocumentReference }) {
  if (snap.updateTime === undefined) {
    throw new Error(`teste: ${snap.ref.path} não existe — não há updateTime`);
  }
  return snap.updateTime;
}

async function limpar(): Promise<void> {
  await Promise.all(Object.values(CONTAS).map((conta) => refFrete(conta).delete()));
}

/* -------------------------------------------------------------------------- */
/*            The real Firestore, with ONE barrier before each update          */
/* -------------------------------------------------------------------------- */

/** Each caller waits until `n` of them arrived: every one is then past its read. */
function barreira(n: number): () => Promise<void> {
  let chegadas = 0;
  let liberar: () => void = () => undefined;
  const aberta = new Promise<void>((resolve) => {
    liberar = resolve;
  });
  return () => {
    chegadas += 1;
    if (chegadas === n) liberar();
    return aberta;
  };
}

/** A property of a real SDK object, methods bound to it (they read private state off `this`). */
function encaminhar(alvo: object, prop: string | symbol): unknown {
  const valor: unknown = Reflect.get(alvo, prop, alvo);
  return typeof valor === 'function' ? (valor as (...a: unknown[]) => unknown).bind(alvo) : valor;
}

/**
 * The real database, except that every `update` of an `int_frete` doc first waits at a barrier of
 * `n`, and records how the SERVER answered it (`null` = landed, else the gRPC code).
 */
function comBarreira(real: Firestore, n: number): { db: Firestore; codigos: (number | null)[] } {
  const chegar = barreira(n);
  const codigos: (number | null)[] = [];

  const embrulharDoc = (ref: DocumentReference): DocumentReference =>
    new Proxy(ref, {
      get(alvo, prop) {
        if (prop !== 'update') return encaminhar(alvo, prop);
        return async (...args: unknown[]): Promise<WriteResult> => {
          await chegar();
          try {
            const metodo = alvo.update as (...a: unknown[]) => Promise<WriteResult>;
            const r = await metodo.apply(alvo, args);
            codigos.push(null);
            return r;
          } catch (err) {
            codigos.push(isGrpcStatusError(err) ? err.code : -1);
            throw err;
          }
        };
      },
    });

  const proxy = new Proxy(real, {
    get(alvo, prop) {
      if (prop !== 'collection') return encaminhar(alvo, prop);
      return (caminho: string) => {
        const colecao = alvo.collection(caminho);
        if (caminho !== INT_FRETE) return colecao;
        return new Proxy(colecao, {
          get(c, p) {
            if (p === 'doc') return (id: string) => embrulharDoc(c.doc(id));
            return encaminhar(c, p);
          },
        });
      };
    },
  });

  return { db: proxy, codigos };
}

/* -------------------------------------------------------------------------- */
/*                                  The suite                                 */
/* -------------------------------------------------------------------------- */

describe.skipIf(!EMULATED)('the freight mapa registration on real Firestore', () => {
  beforeAll(() => {
    // Initialise the admin app with the project the setup pinned.
    db();
  });

  beforeEach(async () => {
    await limpar();
  });

  afterAll(async () => {
    await limpar();
  });

  it('a union onto a NULL, an ABSENT and an existing array: the stored rows come back untouched, the new row last', async () => {
    const legado = [
      { nomeOriginal: 'Legado', idOriginal: null, chaveDesconhecida: { a: 1 } },
      { idOriginal: 42 },
      'uma linha solta',
    ];
    await refFrete(CONTAS.nulo).set(docFrete(CONTAS.nulo, { mapa: null }));
    await refFrete(CONTAS.ausente).set(docFrete(CONTAS.ausente));
    await refFrete(CONTAS.lista).set(docFrete(CONTAS.lista, { mapa: legado }));

    expect(await registrar(CONTAS.nulo, 1)).toEqual({
      resultado: 'registrada',
      mapa: null,
      lidoEmUs: expect.any(Number),
    });
    expect(await registrar(CONTAS.ausente, 2)).toEqual({
      resultado: 'registrada',
      mapa: null,
      lidoEmUs: expect.any(Number),
    });
    expect(await registrar(CONTAS.lista, 3)).toEqual({
      resultado: 'registrada',
      mapa: legado,
      lidoEmUs: expect.any(Number),
    });

    // POSITIVE reads: the docs exist where the helper wrote, with every other field intact.
    const nulo = await refFrete(CONTAS.nulo).get();
    expect(nulo.data()).toEqual(docFrete(CONTAS.nulo, { mapa: [linha('141909---PAC', 1)] }));
    expect((await refFrete(CONTAS.ausente).get()).get('mapa')).toEqual([linha('141909---PAC', 2)]);
    expect((await refFrete(CONTAS.lista).get()).get('mapa')).toEqual([
      ...legado,
      linha('141909---PAC', 3),
    ]);

    // A second order with the same method appends nothing.
    expect((await registrar(CONTAS.lista, 4)).resultado).toBe('ja-presente');
    expect((await refFrete(CONTAS.lista).get()).get('mapa')).toHaveLength(legado.length + 1);
  });

  it('the union’s dedup is STRUCTURAL — the same key set in another order is one value, `7` ≠ `"7"`, `0` ≠ `null`, a duplicate inside one call lands once — and the fake answers exactly the same', async () => {
    const ref = refFrete(CONTAS.uniao);
    const armazenado = [{ b: 2, a: 1 }, 7, null];
    // EQUAL to a stored element: `{ a: 1, b: 2 }` and `null`. NEAR-MISS: one key more (`c: 0`,
    // twice), the string `'7'`, the number `0`.
    const elementos = [{ a: 1, b: 2 }, { a: 1, b: 2, c: 0 }, '7', 0, null, { a: 1, b: 2, c: 0 }];
    const esperado = [{ b: 2, a: 1 }, 7, null, { a: 1, b: 2, c: 0 }, '7', 0];
    await ref.set({ mapa: armazenado });

    await ref.update({ mapa: FieldValue.arrayUnion(...elementos) });

    expect((await ref.get()).get('mapa')).toEqual(esperado);
    // The model `mapaFrete.test.ts` runs on, fed the same union.
    const fake = new FakeDb();
    fake.seed('int_frete/x', { mapa: armazenado });
    await fake
      .collection('int_frete')
      .doc('x')
      .update({ mapa: uniaoDoFake(...elementos) });
    expect(fake.ler('int_frete/x')?.mapa).toEqual(esperado);
  });

  it('Promise.all of two registrations of ONE new key, both past their read ⇒ exactly ONE row; the loser’s write fails 9 and its re-read finds the row', async () => {
    await refFrete(CONTAS.corrida).set(docFrete(CONTAS.corrida, { mapa: [] }));
    const g = comBarreira(db(), 2);

    const resultados = await Promise.all([
      registrar(CONTAS.corrida, 101, g.db),
      registrar(CONTAS.corrida, 202, g.db),
    ]);

    expect(resultados.map((r) => r.resultado).sort()).toEqual(['ja-presente', 'registrada']);
    expect([...g.codigos].sort()).toEqual([9, null]);
    const mapa = (await refFrete(CONTAS.corrida).get()).get('mapa') as DocumentData[];
    expect(mapa).toHaveLength(1);
    expect(mapa[0]?.idOriginal).toBe('141909---PAC');
    expect([linha('141909---PAC', 101), linha('141909---PAC', 202)]).toContainEqual(mapa[0]);
  });

  it('a raw update(…, { lastUpdateTime }) on a DELETED doc fails (9, or 5) and never resurrects it; the helper then answers sem-int-frete', async () => {
    const ref = refFrete(CONTAS.removido);
    await ref.set(docFrete(CONTAS.removido, { mapa: [] }));
    const lido = await ref.get();
    await ref.delete();

    const err: unknown = await ref
      .update(
        { mapa: FieldValue.arrayUnion(linha('141909---PAC', 1)) },
        { lastUpdateTime: carimbo(lido) },
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(isFailedPrecondition(err) || isNotFound(err)).toBe(true);
    expect((await ref.get()).exists).toBe(false);
    expect(await registrar(CONTAS.removido, 1)).toEqual({
      resultado: 'sem-int-frete',
      mapa: null,
      lidoEmUs: expect.any(Number),
    });
    expect((await ref.get()).exists).toBe(false);
  });

  it('a `mapa` that is a map ⇒ mapa-invalido, and the doc keeps its value and its version', async () => {
    const ref = refFrete(CONTAS.mapa);
    const mapa = { '141909---PAC': { integracaoUid: 'me-1' } };
    await ref.set(docFrete(CONTAS.mapa, { mapa }));
    const antes = await ref.get();

    expect(await registrar(CONTAS.mapa, 1)).toEqual({
      resultado: 'mapa-invalido',
      mapa: null,
      lidoEmUs: expect.any(Number),
    });

    const depois = await ref.get();
    expect(depois.get('mapa')).toEqual(mapa);
    expect(carimbo(depois).isEqual(carimbo(antes))).toBe(true);
  });
});
