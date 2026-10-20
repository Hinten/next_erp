/**
 * The label routing route's core on a real Firestore — the emulator of `ci-loja-integrada.yml`,
 * not the in-memory fake.
 *
 * `rotaEtiqueta.test.ts` proves the decisions against `testing/fakeDb.ts`, which MODELS how the
 * server applies the one primitive the route rests on (`update(patch, { lastUpdateTime })`) and
 * stores plain JSON-like values only. This file proves what the fake cannot:
 *
 *  - a stale stamp answers 9 and lands NOTHING — the raw primitive, and the route's own write when
 *    a concurrent writer (a label bought meanwhile) lands between its read and its write: the
 *    server refuses it, the re-read refuses the route, and the concurrent write is all there is;
 *  - the whole-block `freteInicial` update keeps an unmodelled key, and a nested `Timestamp` to the
 *    MICROSECOND — Firestore's own precision (it truncates nanoseconds on write) — with a
 *    sub-millisecond instant, so a round trip through `Date` would show: the block is written back
 *    as read, never re-parsed, so a migrated block survives;
 *  - what it does NOT keep, stated rather than hidden: the WIRE TYPE of an integral double. The
 *    SDK encodes every safe-integer number as an integer, so a sibling stored as the double `1.0`
 *    comes back as the integer `1` — the same value, equal in every comparison and query. The
 *    suite seeds a real double (an `increment` of two halves) and pins both halves of that.
 *
 * ⚠️ It seeds only `pedidos` and `int_frete` docs, under ids no other suite uses, and never an
 * `integracao` doc: the conta trigger the functions emulator loads never fires for this file. Its
 * `beforeEach` deletes exactly the docs it reads. `fetch` is never reached: the route calls nothing.
 */
import { env } from 'node:process';
import {
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  FieldValue,
  type Firestore,
  Timestamp,
  type WriteResult,
} from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isFailedPrecondition, isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { rotearEtiquetaLi } from './rotaEtiqueta';

const EMULATED = Boolean(env.FIRESTORE_EMULATOR_HOST);

const PEDIDOS = 'pedidos';
const INT_FRETE = 'int_frete';

/** Obviously fake ids, distinct from every other emulator suite's. */
const IDS = {
  pedidoBloco: 'pedido-li-rota-ci-bloco',
  pedidoCorrida: 'pedido-li-rota-ci-corrida',
  pedidoCarimbo: 'pedido-li-rota-ci-carimbo',
  docLi: 'lojaIntegrada-conta-li-rota-ci',
  motoboy: 'motoboy-li-rota-ci',
} as const;
const CONTA_REF = 'documents/integracao/conta-li-rota-ci';
const MOTO = { id: 777, code: 'MOTO', nome: 'Entrega local', tipo: 'Motoboy' } as const;
/**
 * A SUB-millisecond instant at Firestore's precision (µs; the server truncates nanoseconds): a
 * round trip through `Date` (ms) would lose its 456 µs.
 */
const SELECAO = new Timestamp(1_800_000_000, 123_456_000);

function db(): Firestore {
  return getAdminFirestore();
}

function refPedido(id: string): DocumentReference {
  return db().collection(PEDIDOS).doc(id);
}

function refIntFrete(id: string): DocumentReference {
  return db().collection(INT_FRETE).doc(id);
}

/** A migrated block: an unmodelled key, a nested Timestamp, a legacy path field. */
function blocoMigrado(over: DocumentData = {}): DocumentData {
  return {
    estado: 'iniciado',
    integracaoFreteOuterRef: `documents/int_frete/${IDS.docLi}`,
    integracaoTargetOuterRef: null,
    externalOptionId: null,
    externalOptionData: MOTO,
    printLabelId: null,
    modalidade: '0',
    enderecoFreteOuterReference: 'documents/clientes/c-ci/enderecos/e-ci',
    valorCobrado: 12.5,
    integracao_path: 'int_frete/legado',
    chaveNaoModelada: { aninhado: [1, 'dois', { tres: null }], selecionadoEm: SELECAO },
    selecionadoEm: SELECAO,
    ...over,
  };
}

function pedido(bloco: DocumentData): DocumentData {
  return {
    estado: 'pago',
    integracaoPedidoOuterRef: CONTA_REF,
    numero: '42',
    ultimaModificacao: 1_800_000_000_000_000,
    freteInicial: bloco,
  };
}

async function semearFrete(): Promise<void> {
  await refIntFrete(IDS.docLi).set({
    tipo: 'lojaIntegrada',
    nome: 'Loja CI',
    ativo: true,
    contaLojaIntegradaEnviosOuterRef: CONTA_REF,
    mapa: [
      {
        nomeOriginal: 'Entrega local - Motoboy',
        idOriginal: '777---MOTO',
        observacao: 'Origem: Pedido 1',
        nomeTarget: null,
        targetData: null,
        integracaoUid: IDS.motoboy,
        targetTipoIntegracao: 'motoboy',
      },
    ],
  });
  await refIntFrete(IDS.motoboy).set({ tipo: 'motoboy', nome: 'Motoboy CI', ativo: true });
}

async function limpar(): Promise<void> {
  await Promise.all([
    refPedido(IDS.pedidoBloco).delete(),
    refPedido(IDS.pedidoCorrida).delete(),
    refPedido(IDS.pedidoCarimbo).delete(),
    refIntFrete(IDS.docLi).delete(),
    refIntFrete(IDS.motoboy).delete(),
  ]);
}

/** A snapshot's commit stamp — present on every snapshot of an existing document. */
function carimbo(snap: { readonly updateTime?: Timestamp; readonly ref: DocumentReference }) {
  if (snap.updateTime === undefined) {
    throw new Error(`teste: ${snap.ref.path} não existe — não há updateTime`);
  }
  return snap.updateTime;
}

/**
 * The wire type a stored value carries (`integerValue`, `doubleValue`, …), read from the snapshot's
 * raw proto — the one thing a decoded JS number cannot show. `protoField` is the SDK's own
 * accessor (internal, but present on every snapshot of the pinned SDK); its absence fails loudly.
 */
function tipoNoFio(snap: DocumentSnapshot, campo: string): string | null {
  const leitor: unknown = Reflect.get(snap, 'protoField');
  if (typeof leitor !== 'function') {
    throw new Error('teste: o snapshot do SDK não expõe mais protoField — reescreva esta prova');
  }
  const proto: unknown = (leitor as (c: string) => unknown).call(snap, campo);
  if (typeof proto !== 'object' || proto === null) return null;
  const valueType: unknown = Reflect.get(proto, 'valueType');
  if (typeof valueType === 'string') return valueType;
  const chaves = Object.keys(proto).filter((k) => k.endsWith('Value'));
  return chaves.length === 1 ? (chaves[0] ?? null) : null;
}

/** A property of a real SDK object, methods bound to it (they read private state off `this`). */
function encaminhar(alvo: object, prop: string | symbol): unknown {
  const valor: unknown = Reflect.get(alvo, prop, alvo);
  return typeof valor === 'function' ? (valor as (...a: unknown[]) => unknown).bind(alvo) : valor;
}

/**
 * The real database, except that the FIRST `update` of a pedido first runs `antes` (a concurrent
 * writer, through the real database), and every pedido `update` records how the SERVER answered
 * it (`null` = landed, else the gRPC code).
 */
function comConcorrente(
  real: Firestore,
  antes: () => Promise<unknown>,
): { db: Firestore; codigos: (number | null)[] } {
  const codigos: (number | null)[] = [];
  let pendente = true;

  const embrulharDoc = (ref: DocumentReference): DocumentReference =>
    new Proxy(ref, {
      get(alvo, prop) {
        if (prop !== 'update') return encaminhar(alvo, prop);
        return async (...args: unknown[]): Promise<WriteResult> => {
          if (pendente) {
            pendente = false;
            await antes();
          }
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
        if (caminho !== PEDIDOS) return colecao;
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

describe.skipIf(!EMULATED)('the label routing route on real Firestore', () => {
  beforeAll(() => {
    // Initialise the admin app with the project the setup pinned.
    db();
  });

  beforeEach(async () => {
    await limpar();
    await semearFrete();
  });

  afterAll(async () => {
    await limpar();
  });

  it('a STALE stamp answers 9 and lands nothing — the raw primitive the route writes with', async () => {
    const ref = refPedido(IDS.pedidoCarimbo);
    await ref.set(pedido(blocoMigrado()));
    const lido = await ref.get();
    await ref.update({ observacoesInternas: 'outra edição' });
    const antes = await ref.get();

    const err: unknown = await ref
      .update(
        { freteInicial: blocoMigrado({ integracaoFreteOuterRef: 'documents/int_frete/x' }) },
        { lastUpdateTime: carimbo(lido) },
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(isFailedPrecondition(err)).toBe(true);
    const depois = await ref.get();
    expect(carimbo(depois).isEqual(carimbo(antes))).toBe(true);
    expect(depois.get('freteInicial.integracaoFreteOuterRef')).toBe(
      `documents/int_frete/${IDS.docLi}`,
    );
  });

  it('a label bought between the route’s read and its write: the server answers 9, the re-read refuses, and only the purchase landed', async () => {
    const ref = refPedido(IDS.pedidoCorrida);
    await ref.set(pedido(blocoMigrado()));
    const comEtiqueta = blocoMigrado({ printLabelId: 'etiqueta-concorrente' });
    const g = comConcorrente(db(), () => ref.update({ freteInicial: comEtiqueta }));

    const r = await rotearEtiquetaLi({ db: g.db }, IDS.pedidoCorrida, null);

    expect(r).toEqual({
      tipo: 'resposta',
      tentativas: 2,
      resposta: { tipo: 'recusado', motivo: 'etiqueta-ja-comprada' },
    });
    expect(g.codigos).toEqual([9]);
    const freteSalvo: unknown = (await ref.get()).get('freteInicial');
    expect(freteSalvo).toEqual(comEtiqueta);
  });

  it('the whole-block update keeps an unmodelled key, a nested sub-millisecond Timestamp and an integral double’s VALUE — only the routing keys change', async () => {
    const ref = refPedido(IDS.pedidoBloco);
    await ref.set(pedido(blocoMigrado({ peso: 0.5 })));
    // A REAL integral double: the SDK writes a safe integer as an integer, but the server sums two
    // doubles into a double.
    await ref.update({ 'freteInicial.peso': FieldValue.increment(0.5) });
    const semeado = await ref.get();
    expect(semeado.get('freteInicial.peso')).toBe(1);
    expect(tipoNoFio(semeado, 'freteInicial.peso')).toBe('doubleValue');

    const r = await rotearEtiquetaLi({ db: db() }, IDS.pedidoBloco, null);

    expect(r).toMatchObject({
      tentativas: 1,
      resposta: { tipo: 'roteado', alvo: { id: IDS.motoboy, tipo: 'motoboy' } },
    });
    const salvo = await ref.get();
    expect(salvo.get('freteInicial')).toEqual(
      blocoMigrado({ integracaoFreteOuterRef: `documents/int_frete/${IDS.motoboy}`, peso: 1 }),
    );
    // A Timestamp is still a Timestamp — at the top of the block and nested in an unmodelled map —
    // with the same instant to the microsecond (sub-millisecond digits included), never a
    // re-serialised map, a number or a millisecond round trip.
    for (const caminho of [
      'freteInicial.selecionadoEm',
      'freteInicial.chaveNaoModelada.selecionadoEm',
    ]) {
      const valor: unknown = salvo.get(caminho);
      expect(valor, caminho).toBeInstanceOf(Timestamp);
      expect((valor as Timestamp).isEqual(SELECAO), caminho).toBe(true);
      expect((valor as Timestamp).nanoseconds, caminho).toBe(123_456_000);
    }
    // The integral double keeps its VALUE; its wire type is the SDK's integer (module header).
    expect(salvo.get('freteInicial.peso')).toBe(1);
    expect(tipoNoFio(salvo, 'freteInicial.peso')).toBe('integerValue');
    // Nothing outside the block moved.
    expect(salvo.get('ultimaModificacao')).toBe(1_800_000_000_000_000);
    expect(salvo.get('estado')).toBe('pago');
  });
});
