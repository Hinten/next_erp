/**
 * The five-minute stock tick on a REAL Firestore — the emulator of
 * `ci-amazon.yml`, not the in-memory fake (step 12, PR 12-e2). The offline
 * suite drives T1–T9 against `testing/fakeDb.ts`; this file runs the tick
 * IN-PROCESS on the real server and proves what only holds if the server
 * behaves as the fake says:
 *
 *  - ★ the idle tick's EXACT cost, counted on the server's own calls (a
 *    counting wrapper around the real Admin SDK): one conta list, one conta
 *    read, one sync-document read, one lease write, ONE `getAll` of the
 *    reconcile run and the stock feed lease, two empty window queries, one
 *    final write — and nothing else;
 *  - ★ a first tick, then a moved row: ONE task named by the row's REAL commit
 *    time; the overlap re-reading the row answers "already enqueued"; a rewrite
 *    that leaves `ultimaModificacao` unchanged (a writer whose clock lost the
 *    maximum) still moves the commit time, so the next tick mints a NEW task;
 *  - ★ the lease and the final write under the server's own preconditions: a
 *    held lease writes nothing, and a write landing between the lease and the
 *    final write is refused, the re-derive keeping the newer cursor;
 *  - the `estoque-sem-deposito` aviso raised and resolved on the flag's
 *    transitions, under the real preconditions;
 *  - ★ T4b (PR 12-f) on the server: a stalled reconcile run re-kicked, and an
 *    expired `montando` lease's pending start handed to its named `vez`
 *    recovery, then cleared under the server's own precondition.
 *
 * ⚠️ The emulator does NOT enforce indexes: a pass here proves the queries'
 * SHAPE and results, never their cost on Enterprise — the index pin is the cost
 * guard (`packages/schemas/src/estoqueAmazon.indexes.test.ts`).
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the tick as `ambiente`, never `process.env` (the lane sets it `off`). The
 * tick makes no Amazon call and binds no client. Both producers are the REAL
 * ones over RECORDING queues: nothing is enqueued onto a queue the lane
 * dispatches.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id and the depósito here start with `e2e-estoque-sincronizacao-`, which no
 * other suite seeds (the window query is filtered on that depósito); the conta
 * is INCOMPLETE (no filial, no `dataCadastro`), so the conta trigger only
 * reads; the tick walks ONLY this file's conta (its conta list is the real
 * query, filtered in memory to that id). Every case wipes what it seeds first,
 * and the file leaves nothing behind.
 */
import { DocumentReference, type Firestore, Query } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FLUXO_FEED_AMAZON,
  INTEGRACAO_TIPO,
  MOTIVO_CONTA_AMAZON,
  idVezFeedAmazon,
  makeEstoqueUid,
  motivoContaAmazonSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { chaveContaPrecisaAtencao } from '../avisos/avisos';
import { criarAgendadorLotesAmazon } from '../feeds/agendadorLotes';
import {
  type TarefaLoteAmazon,
  nomeRecuperacaoFeed,
  nomeRetomadaReconciliacao,
  referenciaVezFeed,
} from '../feeds/tarefaLote';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import { caminhoConta, loggerEspiao } from '../testing/fixtures';
import { criarProdutorEstoqueAmazon } from './produtorEstoque';
import {
  DESFECHO_TICK_ESTOQUE_AMAZON,
  type DepsTickEstoqueAmazon,
  INTERVALO_TICK_ESTOQUE_AMAZON_MS,
  LEITOR_DE_CONTAS_ESTOQUE_AMAZON,
  type ResultadoContaTickEstoqueAmazon,
  executarTickEstoqueAmazon,
} from './sincronizacaoEstoque';
import { type TarefaEstoqueAmazon, referenciaDaObservacao } from './tarefaEstoque';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-estoque-sincronizacao-';
/** The conta of this file — an id no other suite seeds. */
const CONTA = `${P}conta`;
const DEP = `${P}dep`;
const CANONICA = `documents/depositos/${DEP}`;
const REF_CONTA = `documents/integracao/${CONTA}`;
const PRODUTO = `${P}prod`;
const CAMINHO_PRODUTO = `produtos/${PRODUTO}`;
const CAMINHO_ESTOQUE = `${CAMINHO_PRODUTO}/estoques/${makeEstoqueUid(PRODUTO, DEP)}`;
const CAMINHO_SYNC = `sincronizacaoEstoqueAmazon/${CONTA}`;
/** T4b's two documents, read by id: the reconcile run and the stock feed lease. */
const CAMINHO_RUN = `reconciliacaoEstoqueAmazon/${CONTA}`;
const CAMINHO_VEZ = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, CONTA)}`;
const CAMINHO_PEDIDO = `pedidoReconciliacaoEstoqueAmazon/${CONTA}`;
const SKU = `${P}SKU-1`;
/** The tick's clock: an arbitrary ms instant (the window compares it with seeded stamps only). */
const T0 = 2_000_000_000_000;

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE = Object.freeze({ AMAZON_CHAMADAS: 'on', AMAZON_MODO_ESTOQUE: 'dry-run' });

function db(): Firestore {
  return getAdminFirestore();
}

const AVISOS = motivoContaAmazonSchema.options.map(
  (m) => `avisos/${chaveContaPrecisaAtencao(CONTA, m)}`,
);

async function limpar(): Promise<void> {
  await db().recursiveDelete(db().doc(CAMINHO_PRODUTO));
  await Promise.all(
    [CAMINHO_SYNC, CAMINHO_RUN, CAMINHO_VEZ, CAMINHO_PEDIDO, caminhoConta(CONTA), ...AVISOS].map(
      (c) => db().doc(c).delete(),
    ),
  );
}

/** An INCOMPLETE Amazon conta (no filial, no `dataCadastro`), with its depósito unless told otherwise. */
async function semearConta(deposito: string | null = CANONICA): Promise<void> {
  await db()
    .doc(caminhoConta(CONTA))
    .set({
      tipo: INTEGRACAO_TIPO.amazon,
      nome: 'Conta de teste do tick de estoque',
      ativo: true,
      padrao: false,
      selling_partner_id: null,
      ...(deposito === null ? {} : { depositoOuterRef: deposito }),
    });
}

async function semearSync(over: Record<string, unknown> = {}): Promise<void> {
  await db()
    .doc(CAMINHO_SYNC)
    .set({
      cursorMs: T0 - INTERVALO_TICK_ESTOQUE_AMAZON_MS,
      depositoDoCursor: CANONICA,
      vez: null,
      ultimoTickMs: null,
      falhasSeguidas: 0,
      semDeposito: false,
      ...over,
    });
}

/** A produto with ONE link of this conta, carrying a payload no read returns. */
async function semearProduto(): Promise<void> {
  await db().doc(CAMINHO_PRODUTO).set({ nome: 'Produto de teste do tick' });
  await db()
    .doc(`${CAMINHO_PRODUTO}/prodAmazon/${P}link`)
    .set({
      contaAmazonOuterRef: REF_CONTA,
      sku: SKU,
      productDataJson: { pesado: 'x'.repeat(256) },
    });
}

async function linha(ultimaModificacao: number, quantidade = 3) {
  await db()
    .doc(CAMINHO_ESTOQUE)
    .set({ depositoOuterRef: CANONICA, parentId: PRODUTO, ultimaModificacao, quantidade });
  const commit = (await db().doc(CAMINHO_ESTOQUE).get()).updateTime;
  if (commit === undefined) throw new Error('fixture: commit esperado');
  return commit;
}

/* ---------------------- a counting wrapper (test only) --------------------- */

interface Contagem {
  readonly leituras: string[];
  /** `getAll` CALLS (each document of one is a read above). */
  getAlls: number;
  readonly consultas: string[];
  readonly escritas: string[];
}

/**
 * The real Admin SDK, with every call that reaches the server COUNTED: a
 * document `get` (a read), a query `get` (a query, labelled by its collection
 * or group), `getAll` (one read per document) and a document write. Every
 * method runs on the REAL object (`this` is never the wrapper), refs and
 * queries come back wrapped, and a wrapped argument is unwrapped first.
 */
function contando(real: Firestore, c: Contagem): Firestore {
  const alvos = new WeakMap<object, object>();
  const rotulos = new WeakMap<object, string>();
  const desembrulhar = (v: unknown): unknown =>
    typeof v === 'object' && v !== null ? (alvos.get(v) ?? v) : v;
  const embrulhar = (alvo: object, rotulo: string): object => {
    rotulos.set(alvo, rotulo);
    const proxy = new Proxy(alvo, {
      get(t, prop) {
        const valor: unknown = Reflect.get(t, prop, t);
        if (typeof valor !== 'function') return valor;
        return (...args: unknown[]) => {
          const nome = String(prop);
          const reais = args.map(desembrulhar);
          if (t instanceof DocumentReference) {
            if (nome === 'get') c.leituras.push(t.path);
            if (['create', 'update', 'set', 'delete'].includes(nome)) {
              c.escritas.push(`${nome} ${t.path}`);
            }
          } else if (t instanceof Query) {
            if (nome === 'get') c.consultas.push(rotulos.get(t) ?? '?');
          } else if (nome === 'getAll') {
            c.getAlls += 1;
            for (const r of reais) if (r instanceof DocumentReference) c.leituras.push(r.path);
          }
          const saida: unknown = (valor as (...a: unknown[]) => unknown).apply(t, reais);
          if (saida instanceof DocumentReference || saida instanceof Query) {
            const rotulo =
              nome === 'collection' || nome === 'collectionGroup'
                ? String(reais[0])
                : (rotulos.get(t) ?? '?');
            return embrulhar(saida, rotulo);
          }
          return saida;
        };
      },
    });
    alvos.set(proxy, alvo);
    return proxy;
  };
  return embrulhar(real, 'db') as Firestore;
}

/* ---------------------------------- the tick ---------------------------------- */

/** Task ids the recording queue holds, and every task it accepted. */
let idsNaFila = new Set<string>();
let enfileiradas: TarefaEstoqueAmazon[] = [];
/** Every task the recording JOBS queue accepted, with its name. */
let lotes: { tarefa: TarefaLoteAmazon; id: string | null }[] = [];
/** A write a case lands while the batch is enqueued: after the lease, before the final write. */
let duranteOLote: (() => Promise<void>) | null = null;

const produtor = criarProdutorEstoqueAmazon({
  desligado: false,
  fila: () => ({
    enqueue: (tarefa, extras) =>
      (duranteOLote?.() ?? Promise.resolve()).then(() => {
        const id = extras?.id;
        if (id !== undefined && idsNaFila.has(id)) {
          return Promise.reject(falhaDeTarefaJaExistente(id));
        }
        if (id !== undefined) idsNaFila.add(id);
        enfileiradas.push(tarefa);
        return Promise.resolve();
      }),
  }),
});

const agendador = criarAgendadorLotesAmazon({
  desligado: false,
  fila: () => ({
    enqueue: (tarefa, extras) => {
      lotes.push({ tarefa, id: extras?.id ?? null });
      return Promise.resolve();
    },
  }),
});

async function tick(
  agoraMs: number,
  firestore: Firestore = db(),
): Promise<ResultadoContaTickEstoqueAmazon> {
  let n = 0;
  const deps: DepsTickEstoqueAmazon = {
    db: firestore,
    ambiente: AMBIENTE,
    contas: {
      // The real list query, filtered to this file's conta (module header).
      listar: async (d) =>
        (await LEITOR_DE_CONTAS_ESTOQUE_AMAZON.listar(d)).filter((c) => c.integracaoId === CONTA),
      ler: LEITOR_DE_CONTAS_ESTOQUE_AMAZON.ler,
    },
    produtor: () => produtor,
    agendador: () => agendador,
    agora: () => agoraMs,
    logger: loggerEspiao().logger,
    increment: (by) => FieldValue.increment(by),
    gerarExecucaoId: () => {
      n += 1;
      return `${P}exec-${String(agoraMs)}-${String(n)}`;
    },
  };
  const r = await executarTickEstoqueAmazon(deps);
  expect(r.portao).toBeNull();
  expect(r.contas).toHaveLength(1);
  const c = r.contas[0];
  if (c === undefined) throw new Error('sem resultado');
  return c;
}

async function sincronizacao(): Promise<Record<string, unknown> | undefined> {
  return (await db().doc(CAMINHO_SYNC).get()).data();
}

describe.skipIf(!EMULATED)('the stock tick on real Firestore (emulator)', () => {
  beforeEach(async () => {
    expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
    idsNaFila = new Set();
    enfileiradas = [];
    lotes = [];
    duranteOLote = null;
    await limpar();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ the IDLE tick’s exact cost on the server: 1 conta list, 1 conta read, 1 sync read, 1 lease write, ONE getAll of the run and the lease, 2 empty window queries, 1 final write — nothing else', async () => {
    await semearConta();
    await semearSync();
    await semearProduto();
    // Just below the window: the window's lower bound excludes it.
    await linha(T0 - INTERVALO_TICK_ESTOQUE_AMAZON_MS - 20_000);
    const contagem: Contagem = { leituras: [], getAlls: 0, consultas: [], escritas: [] };
    const r = await tick(T0, contando(db(), contagem));
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.janelaVazia,
      paginas: 2,
      linhas: 0,
      produtos: 0,
      sondas: 0,
      tarefas: 0,
    });
    expect(contagem).toEqual({
      leituras: [caminhoConta(CONTA), CAMINHO_SYNC, CAMINHO_RUN, CAMINHO_VEZ],
      getAlls: 1,
      consultas: ['integracao', 'estoques', 'estoques'],
      escritas: [`update ${CAMINHO_SYNC}`, `update ${CAMINHO_SYNC}`],
    });
    expect(await sincronizacao()).toEqual({
      cursorMs: T0,
      depositoDoCursor: CANONICA,
      vez: null,
      ultimoTickMs: T0,
      falhasSeguidas: 0,
      semDeposito: false,
    });
    expect(enfileiradas).toEqual([]);
    expect(lotes).toEqual([]);
  });

  it('★ a first tick, then a moved row: ONE task named by the REAL commit; the overlap dedupes; a rewrite that keeps the stamp mints a NEW task', async () => {
    await semearConta();
    await semearProduto();
    // The first tick (no sync document): the cursor stored at now, no window read.
    expect(await tick(T0)).toMatchObject({ desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.primeiroTick });
    expect(await sincronizacao()).toMatchObject({ cursorMs: T0, depositoDoCursor: CANONICA });

    // The first write: a row stamped 5 s before the next tick, inside the overlap of the one after.
    const t1 = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    const commitA = await linha(t1 - 5_000, 3);
    expect(await tick(t1)).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileirado,
      skus: 1,
      tarefas: 1,
    });
    expect(enfileiradas.map((t) => [t.sku, t.origem, t.referencia])).toEqual([
      [SKU, 'delta', referenciaDaObservacao(commitA)],
    ]);

    // The overlap re-reads the row (the cursor is t1, the window starts at
    // t1 − 20 s): the same observation, already enqueued.
    const t2 = t1 + 10_000;
    expect(await tick(t2)).toMatchObject({ tarefas: 0, jaEnfileiradas: 1 });
    expect(enfileiradas).toHaveLength(1);

    // The second write keeps `ultimaModificacao` (its clock lost the maximum) but changes the
    // row: the commit moves, so the observation is new (the window starts at
    // t2 − 20 s, still below the row's stamp).
    const commitB = await linha(t1 - 5_000, 2);
    expect(commitB.isEqual(commitA)).toBe(false);
    const t3 = t2 + 5_000;
    expect(await tick(t3)).toMatchObject({ tarefas: 1, jaEnfileiradas: 0 });
    expect(enfileiradas.map((t) => t.referencia)).toEqual([
      referenciaDaObservacao(commitA),
      referenciaDaObservacao(commitB),
    ]);
    expect(await sincronizacao()).toMatchObject({ cursorMs: t3, vez: null });
  });

  it('★ the lease and the final write under the REAL preconditions: a held lease writes nothing; a write landing between the lease and the final write is refused by the server, and the re-derive keeps the newer cursor', async () => {
    await semearConta();
    await semearProduto();
    await linha(T0 - 60_000);
    // Another tick holds the lease until T0 + 1: nothing is written.
    await semearSync({ vez: { execucaoId: `${P}outro`, ateMs: T0 + 1 } });
    const antes = (await db().doc(CAMINHO_SYNC).get()).updateTime;
    if (antes === undefined) throw new Error('fixture: commit esperado');
    expect(await tick(T0)).toMatchObject({ desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.leaseOcupado });
    expect((await db().doc(CAMINHO_SYNC).get()).updateTime?.isEqual(antes)).toBe(true);
    expect(enfileiradas).toEqual([]);

    // At the instant it expires this tick takes it. While its one task is
    // enqueued, another writer moves the cursor past this window's end.
    const t1 = T0 + 1;
    const adiante = t1 + 60_000;
    duranteOLote = async () => {
      duranteOLote = null;
      await db().doc(CAMINHO_SYNC).update({ cursorMs: adiante });
    };
    expect(await tick(t1)).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileirado,
      tarefas: 1,
      cursorAvancou: false,
    });
    // NEAR-MISS: a final write without its precondition would have put the
    // cursor back at this window's end, below the newer one.
    expect(await sincronizacao()).toMatchObject({ cursorMs: adiante, vez: null, ultimoTickMs: t1 });
  });

  it('★ T4b on the server: ONE getAll of the run and the lease; a stalled live run RE-KICKED by its stall’s name; an expired montando’s start handed to its NAMED vez recovery, then cleared under the server’s own precondition', async () => {
    await semearConta();
    await semearSync();
    await db()
      .doc(CAMINHO_RUN)
      .set({
        execucaoId: `${P}run`,
        fase: 'varrendo',
        depositoOuterRef: CANONICA,
        proximaPagina: 1,
        paginas: 1,
        progressoEmMs: T0 - 16 * 60_000,
        iniciadaEmMs: T0 - 60 * 60_000,
      });
    await db()
      .doc(CAMINHO_VEZ)
      .set({
        estado: 'montando',
        execucaoId: `${P}morto`,
        ateMs: T0 - 1,
        atualizadoEmMs: T0 - 11 * 60_000,
        pendenteDesdeMs: T0 - 30 * 60_000,
      });
    const antes = (await db().doc(CAMINHO_VEZ).get()).updateTime;
    const contagem: Contagem = { leituras: [], getAlls: 0, consultas: [], escritas: [] };
    const r = await tick(T0, contando(db(), contagem));
    expect(r).toMatchObject({ retomada: 'retomada', inicioRecuperado: true });
    expect(contagem.getAlls).toBe(1);
    expect(contagem.escritas).toContain(`update ${CAMINHO_VEZ}`);
    expect(lotes.map((l) => [l.tarefa.tipo, l.id])).toEqual([
      ['reconciliacao', nomeRetomadaReconciliacao(CONTA, `${P}run`, 1, T0 - 16 * 60_000)],
      [
        'feed-recuperar',
        nomeRecuperacaoFeed(CONTA, referenciaVezFeed(`${P}morto`), T0 - 30 * 60_000),
      ],
    ]);
    const vez = await db().doc(CAMINHO_VEZ).get();
    expect(vez.data()).toMatchObject({
      estado: 'montando',
      pendenteDesdeMs: null,
      atualizadoEmMs: T0,
    });
    expect(vez.updateTime?.isEqual(antes ?? vez.updateTime)).toBe(false);
    // The run itself is the page's to move: the re-kick wrote nothing on it.
    expect(contagem.escritas.filter((e) => e.endsWith(CAMINHO_RUN))).toEqual([]);
  });

  it('the estoque-sem-deposito aviso: raised on false → true, resolved on true → false, under the real preconditions', async () => {
    const aviso = `avisos/${chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.estoqueSemDeposito)}`;
    await semearConta(null);
    await semearSync();
    expect(await tick(T0)).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.semDeposito,
      aviso: 'levantado',
    });
    expect((await db().doc(aviso).get()).data()).toMatchObject({
      motivo: MOTIVO_CONTA_AMAZON.estoqueSemDeposito,
      resolvidoEm: null,
    });
    expect(await sincronizacao()).toMatchObject({ semDeposito: true, vez: null });

    await semearConta();
    const t1 = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    expect(await tick(t1)).toMatchObject({ aviso: 'resolvido', semDeposito: false });
    expect((await db().doc(aviso).get()).data()?.resolvidoEm).not.toBeNull();
    expect(await sincronizacao()).toMatchObject({ semDeposito: false, vez: null });
  });
});
