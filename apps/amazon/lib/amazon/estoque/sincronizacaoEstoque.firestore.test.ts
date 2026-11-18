/**
 * The five-minute stock tick on a REAL Firestore — the emulator of
 * `ci-amazon.yml`, not the in-memory fake (step 12, PR 12-e2). The offline
 * suite drives T1–T9 against `testing/fakeDb.ts`; this file runs the tick
 * IN-PROCESS on the real server and proves what only holds if the server
 * behaves as the fake says:
 *
 *  - ★ the idle tick's EXACT cost, counted on the server's own calls (a
 *    counting wrapper around the real Admin SDK): one conta list, one conta
 *    read, one sync-document read, one lease write, two empty window queries,
 *    one final write — and nothing else;
 *  - ★ a first tick, then a moved row: ONE task named by the row's REAL commit
 *    time; the overlap re-reading the row answers "already enqueued"; a rewrite
 *    that leaves `ultimaModificacao` unchanged (a writer whose clock lost the
 *    maximum) still moves the commit time, so the next tick mints a NEW task;
 *  - ★ the commit lag on the server's REAL commit times: a row stamped below
 *    `cursor − 20 s` but committed after it is kept (ONE task), one stamped
 *    below the 5-minute reach-back is not, whatever its commit, and one stamped
 *    inside the reach-back but committed before `cursor − 20 s` is returned and
 *    dropped;
 *  - ★ the lease and the final write under the server's own preconditions: a
 *    held lease writes nothing, and a write landing between the lease and the
 *    final write is refused, the re-derive keeping the newer cursor;
 *  - the `estoque-sem-deposito` aviso raised and resolved on the flag's
 *    transitions, under the real preconditions.
 *
 * ⚠️ The emulator does NOT enforce indexes: a pass here proves the queries'
 * SHAPE and results, never their cost on Enterprise — the index pin is the cost
 * guard (`packages/schemas/src/estoqueAmazon.indexes.test.ts`).
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the tick as `ambiente`, never `process.env` (the lane sets it `off`). The
 * tick makes no Amazon call and binds no client. The producer is the REAL one
 * over a RECORDING queue: nothing is enqueued onto a queue the lane dispatches.
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
  INTEGRACAO_TIPO,
  MOTIVO_CONTA_AMAZON,
  makeEstoqueUid,
  motivoContaAmazonSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { chaveContaPrecisaAtencao } from '../avisos/avisos';
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
const SKU = `${P}SKU-1`;
/**
 * The tick's clock in every case but the commit lag's: an arbitrary ms instant
 * years AHEAD of the emulator's real commit times, so the window's commit test
 * (a commit after `cursor − 20 s`) keeps no row there and the seeded stamps
 * alone decide. The commit-lag case runs on the real clock instead.
 */
const T0 = 2_000_000_000_000;
/** How far the tick's window reaches below its cursor, written out (the five minutes). */
const CINCO_MINUTOS_MS = 300_000;

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
    [CAMINHO_SYNC, caminhoConta(CONTA), ...AVISOS].map((c) => db().doc(c).delete()),
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
    duranteOLote = null;
    await limpar();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ the IDLE tick’s exact cost on the server: 1 conta list, 1 conta read, 1 sync read, 1 lease write, 2 empty window queries, 1 final write — nothing else', async () => {
    await semearConta();
    await semearSync();
    await semearProduto();
    // Just below the window's reach-back: the window's lower bound excludes it.
    await linha(T0 - INTERVALO_TICK_ESTOQUE_AMAZON_MS - CINCO_MINUTOS_MS);
    const contagem: Contagem = { leituras: [], consultas: [], escritas: [] };
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
      leituras: [caminhoConta(CONTA), CAMINHO_SYNC],
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

    // The overlap re-reads the row (the cursor is t1, the window keeps every
    // row stamped after t1 − 20 s): the same observation, already enqueued.
    const t2 = t1 + 10_000;
    expect(await tick(t2)).toMatchObject({ tarefas: 0, jaEnfileiradas: 1 });
    expect(enfileiradas).toHaveLength(1);

    // The second write keeps `ultimaModificacao` (its clock lost the maximum) but changes the
    // row: the commit moves, so the observation is new (the window keeps every
    // row stamped after t2 − 20 s, still below the row's stamp).
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

  it('★ the commit lag on REAL commit times: a row stamped below cursor − 20 s but committed after it ⇒ ONE task; NEAR-MISS: stamped below the 5-minute reach-back ⇒ none', async () => {
    await semearConta();
    await semearProduto();
    // The real clock: the server's commit times are compared with this cursor.
    const base = Date.now();
    const cursorMs = base - 60_000;

    // NEAR-MISS first: stamped base − 7 min, below cursor − 5 min, committed now.
    await semearSync({ cursorMs });
    await linha(base - 7 * 60_000);
    expect(await tick(Date.now())).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.janelaVazia,
      linhas: 0,
      tarefas: 0,
    });
    expect(enfileiradas).toEqual([]);

    // The same cursor again, the row rewritten stamped base − 100 s: below
    // cursor − 20 s (base − 80 s), so only its real commit, now, keeps it.
    await semearSync({ cursorMs });
    const commit = await linha(base - 100_000, 2);
    expect(commit.toMillis()).toBeGreaterThan(cursorMs - 20_000);
    const agora = Date.now();
    expect(await tick(agora)).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileirado,
      linhas: 1,
      skus: 1,
      tarefas: 1,
    });
    expect(enfileiradas.map((t) => [t.sku, t.origem, t.referencia])).toEqual([
      [SKU, 'delta', referenciaDaObservacao(commit)],
    ]);
    expect(await sincronizacao()).toMatchObject({ cursorMs: agora, vez: null });
  });

  it('★ the commit test DROPS on REAL commit times: a row stamped inside the reach-back but committed before cursor − 20 s is returned and dropped, no produto read, no task', async () => {
    await semearConta();
    await semearProduto();
    const base = Date.now();
    const commit = await linha(base - 60_000);
    // The cursor 21 s after the row's real commit: the commit test (after
    // cursor − 20 s) drops it, while its stamp (about commit − 60 s) is above
    // cursor − 5 min and below cursor − 20 s.
    const cursorMs = commit.toMillis() + 21_000;
    expect(base - 60_000).toBeGreaterThan(cursorMs - CINCO_MINUTOS_MS);
    await semearSync({ cursorMs });
    const contagem: Contagem = { leituras: [], consultas: [], escritas: [] };
    const r = await tick(cursorMs + INTERVALO_TICK_ESTOQUE_AMAZON_MS, contando(db(), contagem));
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.janelaVazia,
      linhas: 1,
      produtos: 0,
      skus: 0,
      tarefas: 0,
    });
    expect(enfileiradas).toEqual([]);
    expect(contagem.leituras.filter((c) => c.startsWith('produtos/'))).toEqual([]);
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
