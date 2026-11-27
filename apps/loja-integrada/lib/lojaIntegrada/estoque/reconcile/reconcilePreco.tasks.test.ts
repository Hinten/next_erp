/**
 * The daily reconcile's PRICE ARM, ERP side (master plan step 13, PR 13-f1), against the REAL
 * emulators (`ci-loja-integrada.yml`), IN PROCESS on the stock suite's precedent
 * (`reconcileEstoque.tasks.test.ts`): every slice run by THIS process (`despacharReconcileEstoqueLi`),
 * its hand-offs RECORDED and driven by hand — so no deployed reads-queue dispatch drives the same
 * lease beside it — and the valves passed as a PARAMETER (`ambiente`), never `process.env`. The
 * read switch stays off: this side of the price arm never calls the store.
 *
 * A Proxy around the real Admin Firestore records every `getAll` — its paths, its field mask, and
 * the fields each document came back with — and moves the world's clock by a fixed step on each
 * one, so the budget cuts the run across slices and every slice after the first meets, on the real
 * server, the documents an earlier slice wrote (each update under its own read's stamp).
 *
 * 1. **A price-only run** (stock `off`, price `dry-run`):
 *    - the key walk over the real collection group, its produtos read through the PRICE mask
 *      alone, and the server answering the masked fields only;
 *    - the price root of another run updated under its read at the take, the run's folded tabelas
 *      fixed in it, and every one of the 32 buckets written with this run's id — a bucket of
 *      another run replaced, its valid entry's target and deferral carried as `ap` / `tp`, an id
 *      no longer linked left behind, and the carry emptied at the parents phase's end;
 *    - the parents phase's ONE masked `getAll` of the distinct parents (one of them absent), and
 *      every child's target: a propagating parent's prices, a non-propagating parent's child's
 *      own, a root's own with the promotion cleared, a root with no price held, a child of a
 *      missing parent held;
 *    - the end: `ultimoReconcilePreco` with the RUN's tabelas and counters, no aviso under
 *      `dry-run` (ONE INFO line instead), the lease released — and no stock document at all.
 * 2. **Both arms in one walk** (stock `dry-run`, price `dry-run`): each page's produtos read ONCE
 *    through the UNION mask (the stock fields and the price fields), the server answering those
 *    fields only; the stock store phase stopping at the read switch; both ends written.
 *
 * Isolation (`vitest.tasks.config.ts`, the price arm's rule set): conta, depósito, tabela and produto
 * ids no other suite seeds; the conta CREATED (the conta trigger's arms never fire on a create) with
 * no filial, so that trigger only reads; every produto CREATED after a delete and never updated, so
 * the price trigger stops at its relevance gate; every link create's anchor write awaited; no stock
 * record written, so the stock trigger never fires; the run document AND the price slot wiped
 * before and after every case; the teardown deletes the price documents (root and buckets) FIRST,
 * then the stock ones, the links (the anchor's last write awaited), the produtos, the conta and its
 * avisos. The conta HAS a depósito, so it would join any dispatched run's conta list: the files run
 * one at a time and the conta is gone at the teardown, which keeps the stock suite's `run.contas`
 * assertion exact.
 *
 * NOT proven here: the declared indexes and the scan cost on Enterprise (pinned offline against
 * `firestore.indexes.json`), Cloud Scheduler, named-task dedup, and any store call (none on this
 * side, and none before the cutover). Every value is INVENTED (`testing/precoLi.ts` conventions).
 */
import {
  type DocumentData,
  DocumentReference,
  type DocumentSnapshot,
  FieldValue,
  type Firestore,
} from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';
import {
  BALDES_SNAPSHOT_ESTOQUE_LI,
  FASE_RECONCILE_ESTOQUE_LI,
  FLAG_ENTRADA_PRECO_LI,
  ID_SLOT_PRECO_RECONCILE_LI,
  INTEGRACAO_TIPO,
  MOTIVO_RETENCAO_PRECO_LI,
  TIPO_AVISO,
  TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  baldeSnapshotEstoqueLi,
  chaveDeAviso,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { CHAMADAS_ENV_LI, MODO_LI, VALVULA_ENV_LI } from '../../core/valvulas';
import { CAMPOS_PRODUTO_PRECO_LI } from '../../preco/leituraPrecoErp';
import { aguardarAncoraLi, comConta, semConta } from '../../testing/ancoraLi';
import { gravadorDeLog } from '../../testing/fixtures';
import {
  AGORA_RECONCILE_MS,
  agendadorGravador,
  loggerGravador,
} from '../../testing/reconcileEstoqueLi';
import { CAMPOS_PRODUTO_ESTOQUE_LI } from '../leituraEstoqueErp';
import {
  type DepsReconcileEstoqueLi,
  type ResultadoReconcileLi,
  despacharReconcileEstoqueLi,
} from './despachoReconcile';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

/** Obviously fake ids, distinct from every other emulator suite's. */
const CONTA = 'conta-li-reconcile-preco-ci';
const DEP = 'dep-li-reconcile-preco-ci';
const TAB_N = 'tab-li-reconcile-preco-ci-normal';
const TAB_P = 'tab-li-reconcile-preco-ci-promo';
const RUN = 'estoque-reconcile-ci-preco';
const RUN_VELHO = 'estoque-reconcile-ci-preco-velho';
const RUN_PATH = 'reconcileEstoqueLojaIntegrada/atual';
const SLOT_PRECO_PATH = `reconcileEstoqueLojaIntegrada/${ID_SLOT_PRECO_RECONCILE_LI}`;
const RAIZ_PRECO_PATH = `sincPrecoLojaIntegrada/${CONTA}`;
const RAIZ_ESTOQUE_PATH = `sincEstoqueLojaIntegrada/${CONTA}`;

/** A propagating parent (no flag), linked as a store PARENT. */
const PAI_A = 'pr-li-recpreco-ci-pai-a';
/** A parent that does not propagate, unlinked. */
const PAI_B = 'pr-li-recpreco-ci-pai-b';
/** A parent id no document holds. */
const PAI_FANTASMA = 'pr-li-recpreco-ci-pai-fantasma';
const FILHO_A1 = 'pr-li-recpreco-ci-fa-1';
const FILHO_A2 = 'pr-li-recpreco-ci-fa-2';
const FILHO_B1 = 'pr-li-recpreco-ci-fb-1';
const RAIZ = 'pr-li-recpreco-ci-raiz';
const SEM_PRECO = 'pr-li-recpreco-ci-sem-preco';
const FANTASMA = 'pr-li-recpreco-ci-fx';
const PRODUTOS = [PAI_A, PAI_B, FILHO_A1, FILHO_A2, FILHO_B1, RAIZ, SEM_PRECO, FANTASMA] as const;

/** Invented store ids (from 1000): the parent, then its children and the roots. */
const ID = { paiA: 1100, a1: 1101, a2: 1102, b1: 1103, raiz: 1104, semPreco: 1105, fx: 1106 };
/** An id in the same bucket as {@link ID.a1} that no link names any more. */
const ID_SEM_VINCULO = 1133;

function db(): Firestore {
  return getAdminFirestore();
}

const preco = (valor: number) => ({ valor });

/** The avisos this suite's conta could raise (none under `dry-run`). */
function chavesDosAvisos(): string[] {
  return [
    chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaPrecoSemErp, conta: CONTA }),
    chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaEstoqueSemErp, conta: CONTA }),
  ];
}

async function limpar(): Promise<void> {
  // The price documents FIRST (root and buckets), then the stock ones, then the run and the slot.
  await db().recursiveDelete(db().doc(RAIZ_PRECO_PATH));
  await db().recursiveDelete(db().doc(RAIZ_ESTOQUE_PATH));
  await db().doc(RUN_PATH).delete();
  await db().doc(SLOT_PRECO_PATH).delete();
  for (const produtoId of PRODUTOS) {
    const ref = db().collection('produtos').doc(produtoId);
    const links = await ref.collection('produtolojaintegrada').get();
    for (const link of links.docs) await link.ref.delete();
    if (!links.empty && (await ref.get()).exists) {
      await aguardarAncoraLi(db(), produtoId, semConta(CONTA), `sem a conta (${produtoId})`);
    }
    await db().recursiveDelete(ref);
  }
  await db().recursiveDelete(db().collection('integracao').doc(CONTA));
  for (const chave of chavesDosAvisos()) await db().collection('avisos').doc(chave).delete();
}

/** The conta, by a CREATE: a depósito and both tabelas, no filial (the conta trigger only reads). */
async function semearConta(): Promise<void> {
  await db()
    .collection('integracao')
    .doc(CONTA)
    .create({
      tipo: INTEGRACAO_TIPO.lojaIntegrada,
      nome: 'Loja reconcile de preço CI',
      ativo: true,
      depositoOuterRef: `documents/depositos/${DEP}`,
      tabelaNormalOuterRef: `documents/listaDePrecos/${TAB_N}`,
      tabelaPromocionalOuterRef: `documents/listaDePrecos/${TAB_P}`,
    });
}

/** A produto by a CREATE, then its one link, the anchor's add awaited before anything reads it. */
async function semearProduto(
  produtoId: string,
  dados: DocumentData,
  link: DocumentData | null,
): Promise<void> {
  const ref = db().collection('produtos').doc(produtoId);
  await ref.create({ sku: `SKU-${produtoId}`, nome: `Produto ${produtoId}`, ...dados });
  if (link === null) return;
  await ref.collection('produtolojaintegrada').doc('l1').create(link);
  await aguardarAncoraLi(db(), produtoId, comConta(CONTA), `com a conta (${produtoId})`);
}

/** A child link of the conta to store id `id`, under the invented store parent. */
const linkFilho = (id: number) => ({
  contaLojaIntegrada: `documents/integracao/${CONTA}`,
  id,
  paiProdutoIntegradaId: ID.paiA,
  removido: false,
});

/** The store parent's own link: a root with grades. */
const LINK_PAI = {
  contaLojaIntegrada: `documents/integracao/${CONTA}`,
  id: ID.paiA,
  paiProdutoIntegradaId: null,
  grades: [1],
  removido: false,
};

/** One `getAll` as the Proxy saw it: paths, mask, and each EXISTING document's fields, sorted. */
interface GetAllObservadoLi {
  readonly caminhos: readonly string[];
  readonly mascara: readonly string[] | null;
  readonly campos: readonly (readonly string[])[];
}

/**
 * The real Firestore behind a Proxy that records every `getAll` (module header) and moves
 * `relogio` by `passoMs` on each. Every other member is the real one's, bound to it.
 */
function firestoreObservado(
  alvo: Firestore,
  relogio: { agora: number },
  passoMs: number,
): { readonly db: Firestore; readonly getAlls: GetAllObservadoLi[] } {
  const getAlls: GetAllObservadoLi[] = [];
  const observado = new Proxy(alvo, {
    get(t, prop) {
      if (prop === 'getAll') {
        return async (...args: Parameters<Firestore['getAll']>): Promise<DocumentSnapshot[]> => {
          const ultimo = args.at(-1);
          const opcao =
            ultimo !== undefined && !(ultimo instanceof DocumentReference)
              ? (ultimo as { readonly fieldMask?: readonly unknown[] })
              : null;
          const refs = args.filter((a): a is DocumentReference => a instanceof DocumentReference);
          const snaps = await t.getAll(...args);
          getAlls.push({
            caminhos: refs.map((r) => r.path),
            mascara: opcao?.fieldMask === undefined ? null : opcao.fieldMask.map(String),
            campos: snaps.filter((s) => s.exists).map((s) => Object.keys(s.data() ?? {}).sort()),
          });
          relogio.agora += passoMs;
          return snaps;
        };
      }
      const valor: unknown = Reflect.get(t, prop, t);
      return typeof valor === 'function' ? (valor as (...a: unknown[]) => unknown).bind(t) : valor;
    },
  });
  return { db: observado, getAlls };
}

/** Every `getAll` of ERP produtos only (the walk's pages and the parents phase). */
function getAllsDeProdutos(getAlls: readonly GetAllObservadoLi[]): GetAllObservadoLi[] {
  return getAlls.filter(
    (g) => g.caminhos.length > 0 && g.caminhos.every((c) => /^produtos\/[^/]+$/.test(c)),
  );
}

/** One bucket's stored data, by the store id it holds. */
async function balde(idLi: number): Promise<DocumentData | undefined> {
  const id = baldeSnapshotEstoqueLi(String(idLi)) ?? '';
  return (await db().doc(`${RAIZ_PRECO_PATH}/snapshot/${id}`).get()).data();
}

/** The chain from seq 0 to its end, slice by slice, every hand-off recorded (module header). */
async function cadeia(
  dbDaCadeia: Firestore,
  relogio: { agora: number },
  ambiente: DepsReconcileEstoqueLi['ambiente'],
): Promise<{
  readonly resultados: ResultadoReconcileLi[];
  readonly log: ReturnType<typeof loggerGravador>;
  readonly entregas: ReturnType<typeof agendadorGravador>;
}> {
  const log = loggerGravador();
  const entregas = agendadorGravador();
  const resultados: ResultadoReconcileLi[] = [];
  let seq = 0;
  for (let n = 0; n < 80; n += 1) {
    const r = await despacharReconcileEstoqueLi(
      dbDaCadeia,
      { tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI, execucaoId: RUN, seq },
      {
        ambiente,
        agoraMs: () => relogio.agora,
        inicioMs: relogio.agora,
        tentativa: 0,
        idTarefa: null,
        esperar: () => Promise.resolve(),
        increment: (by) => FieldValue.increment(by),
        agendador: () => entregas.agendador,
        // No stock send is ever due on this side: building the stock producer is a failure.
        agendadorEstoque: () => {
          throw new TypeError('reconcilePreco.tasks: nenhum envio de estoque é esperado');
        },
        logger: log.logger,
        escrever: gravadorDeLog().escrever,
        tamanhoPaginaCaminhada: 2,
      },
    );
    resultados.push(r);
    if (r.kind !== 'continua') return { resultados, log, entregas };
    seq = r.seq;
    relogio.agora += 2_000;
  }
  throw new Error('a cadeia do reconcile não terminou em 80 fatias');
}

describe.skipIf(!EMULATED || !TASKS)(
  'the reconcile’s price arm, ERP side, against the emulators',
  () => {
    const redeGlobal: string[] = [];

    beforeAll(() => {
      db();
    });

    beforeEach(async () => {
      __resetAllReadCaches();
      await limpar();
      const anterior = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          redeGlobal.push(url);
          return anterior(input, init);
        },
      );
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      __resetAllReadCaches();
      const loja = new URL(URL_BASE_LI).hostname;
      const vazadas = redeGlobal.filter((u) => new URL(u).hostname === loja);
      redeGlobal.length = 0;
      expect(vazadas).toEqual([]);
      await limpar();
    });

    afterAll(async () => {
      await limpar();
    });

    it(
      'a PRICE-ONLY run (stock off, price dry-run): the walk through the price mask, every bucket of this run with the carry taken back, the parents read once, the targets, the end — and no stock document',
      { timeout: 240_000 },
      async () => {
        expect(process.env[CHAMADAS_ENV_LI]).not.toBe('on');
        expect(process.env[VALVULA_ENV_LI.preco]).not.toBe('on');
        await semearConta();
        // The price root and one bucket as another run left them: replaced by this run.
        await db()
          .doc(RAIZ_PRECO_PATH)
          .create({
            execucaoPreco: {
              execucaoId: RUN_VELHO,
              tabelas: { normal: 'tab-li-reconcile-preco-ci-velha', promocional: null },
              amostras: {},
              contadores: { validos: 99 },
              candidatos: [],
              mantidos: [],
            },
          });
        await db()
          .doc(`${RAIZ_PRECO_PATH}/snapshot/${baldeSnapshotEstoqueLi(String(ID.a1)) ?? ''}`)
          .create({
            execucaoId: RUN_VELHO,
            e: {
              [String(ID.a1)]: {
                p: FILHO_A1,
                f: FLAG_ENTRADA_PRECO_LI.valido,
                pai: PAI_A,
                a: { c: 6666, q: null },
                t: true,
              },
              [String(ID_SEM_VINCULO)]: {
                p: 'pr-li-recpreco-ci-velho',
                f: FLAG_ENTRADA_PRECO_LI.valido,
                a: { c: 7777, q: null },
              },
            },
            anteriores: {},
          });
        // A propagating parent, linked as a store parent; its children price from ITS entries.
        await semearProduto(
          PAI_A,
          { precos: { [TAB_N]: preco(55.55), [TAB_P]: preco(44.44) } },
          LINK_PAI,
        );
        await semearProduto(
          FILHO_A1,
          { paiId: PAI_A, precos: { [TAB_N]: preco(33.33) } },
          linkFilho(ID.a1),
        );
        await semearProduto(FILHO_A2, { paiId: PAI_A }, linkFilho(ID.a2));
        // A parent that does not propagate: its child keeps its own prices.
        await semearProduto(
          PAI_B,
          { precos: { [TAB_N]: preco(99.99) }, propagatePriceToChildren: false },
          null,
        );
        await semearProduto(
          FILHO_B1,
          { paiId: PAI_B, precos: { [TAB_N]: preco(22.22), [TAB_P]: preco(11.11) } },
          linkFilho(ID.b1),
        );
        // A root with no promotion (cleared), a root with no price (held), a missing parent (held).
        await semearProduto(RAIZ, { precos: { [TAB_N]: preco(77.77) } }, linkFilho(ID.raiz));
        await semearProduto(SEM_PRECO, { precos: {} }, linkFilho(ID.semPreco));
        await semearProduto(
          FANTASMA,
          { paiId: PAI_FANTASMA, precos: { [TAB_N]: preco(11.11) } },
          linkFilho(ID.fx),
        );

        const relogio = { agora: AGORA_RECONCILE_MS };
        const observado = firestoreObservado(db(), relogio, 12_000);
        const { resultados, log, entregas } = await cadeia(observado.db, relogio, {
          [VALVULA_ENV_LI.estoque]: MODO_LI.off,
          [VALVULA_ENV_LI.preco]: MODO_LI.dryRun,
        });

        expect(resultados.at(-1)).toEqual({ kind: 'encerrado' });
        // The budget cut the run: more than one slice, each handed off by name to the next.
        expect(resultados.length).toBeGreaterThan(2);
        expect(entregas.enfileirados.map((e) => e.seq)).toEqual(
          resultados.flatMap((r) => (r.kind === 'continua' ? [r.seq] : [])),
        );
        // Never a stock phase: the walk, the parents phase beside `fila`, the end.
        for (const r of resultados) {
          if (r.kind !== 'continua') continue;
          expect([
            FASE_RECONCILE_ESTOQUE_LI.erp,
            FASE_RECONCILE_ESTOQUE_LI.fila,
            FASE_RECONCILE_ESTOQUE_LI.fim,
          ]).toContain(r.fase);
          if (r.fase === FASE_RECONCILE_ESTOQUE_LI.fila) expect(r.fasePreco).toBe('pais-preco');
        }

        const run = (await db().doc(RUN_PATH).get()).data();
        // Nothing else in the emulator is a conta of this run — else every counter below misleads.
        expect(run?.contas, 'outra conta com depósito ficou no emulador').toEqual([CONTA]);
        expect(run).toMatchObject({
          execucaoId: RUN,
          fase: FASE_RECONCILE_ESTOQUE_LI.fim,
          fasePreco: null,
          emExecucaoAteMs: 0,
        });
        expect(run?.contadores).toMatchObject({ precoNoRun: 1, estoqueForaDoRun: 1 });

        // The walk's produtos and the parents, each through the PRICE mask alone — and the server
        // answered the masked fields only (never `sku`, `nome` or the anchor).
        const deProdutos = getAllsDeProdutos(observado.getAlls);
        expect(deProdutos.length).toBeGreaterThan(1);
        for (const g of deProdutos) {
          expect(g.mascara).toEqual([...CAMPOS_PRODUTO_PRECO_LI]);
          for (const campos of g.campos) {
            for (const campo of campos) expect(CAMPOS_PRODUTO_PRECO_LI).toContain(campo);
          }
        }
        const lidos = deProdutos.flatMap((g) => g.caminhos);
        for (const produtoId of [FILHO_A1, FILHO_A2, FILHO_B1, RAIZ, SEM_PRECO, FANTASMA]) {
          expect(lidos).toContain(`produtos/${produtoId}`);
        }
        // The parents phase: ONE read of the three distinct parents, in id order; one is absent.
        const dosPais = deProdutos.filter((g) =>
          g.caminhos.some((c) => c === `produtos/${PAI_FANTASMA}`),
        );
        expect(dosPais).toHaveLength(1);
        expect(dosPais[0]?.caminhos).toEqual(
          [PAI_A, PAI_B, PAI_FANTASMA].sort().map((id) => `produtos/${id}`),
        );
        expect(dosPais[0]?.campos).toHaveLength(2);
        // Each parent read ONCE in the whole run (the walk never reads one: a parent's own link is
        // a `pai` entry, and the other parent has none).
        for (const paiId of [PAI_A, PAI_B]) {
          expect(lidos.filter((c) => c === `produtos/${paiId}`)).toHaveLength(1);
        }

        // No stock document: no root, no snapshot, no kits map.
        const raizEstoque = db().doc(RAIZ_ESTOQUE_PATH);
        expect((await raizEstoque.get()).exists).toBe(false);
        expect(await raizEstoque.listCollections()).toEqual([]);

        // Every bucket of this run, exactly the 32 (never the reserved parents document).
        const baldes = await db().collection(`${RAIZ_PRECO_PATH}/snapshot`).get();
        expect(baldes.docs.map((d) => d.id).sort()).toEqual(
          Array.from({ length: BALDES_SNAPSHOT_ESTOQUE_LI }, (_, i) => String(i).padStart(2, '0')),
        );
        for (const d of baldes.docs) {
          expect(d.data(), d.id).toMatchObject({ execucaoId: RUN, anteriores: {} });
        }
        const entrada = async (idLi: number) =>
          ((await balde(idLi))?.e as Record<string, unknown> | undefined)?.[String(idLi)];
        // The bucket of another run: its valid entry's target and deferral taken back as `ap`/`tp`,
        // the id no link names left behind.
        expect(await entrada(ID.a1)).toEqual({
          p: FILHO_A1,
          f: FLAG_ENTRADA_PRECO_LI.valido,
          pai: PAI_A,
          n: 3333,
          a: { c: 5555, q: 4444 },
          ap: { c: 6666, q: null },
          tp: true,
        });
        expect(await entrada(ID_SEM_VINCULO)).toBeUndefined();
        expect(await entrada(ID.paiA)).toEqual({ p: PAI_A, f: FLAG_ENTRADA_PRECO_LI.pai });
        expect(await entrada(ID.a2)).toEqual({
          p: FILHO_A2,
          f: FLAG_ENTRADA_PRECO_LI.valido,
          pai: PAI_A,
          a: { c: 5555, q: 4444 },
        });
        expect(await entrada(ID.b1)).toEqual({
          p: FILHO_B1,
          f: FLAG_ENTRADA_PRECO_LI.valido,
          pai: PAI_B,
          n: 2222,
          pr: 1111,
          a: { c: 2222, q: 1111 },
        });
        expect(await entrada(ID.raiz)).toEqual({
          p: RAIZ,
          f: FLAG_ENTRADA_PRECO_LI.valido,
          n: 7777,
          a: { c: 7777, q: null },
        });
        expect(await entrada(ID.semPreco)).toEqual({
          p: SEM_PRECO,
          f: FLAG_ENTRADA_PRECO_LI.valido,
          a: { r: MOTIVO_RETENCAO_PRECO_LI.semPreco },
        });
        expect(await entrada(ID.fx)).toEqual({
          p: FANTASMA,
          f: FLAG_ENTRADA_PRECO_LI.valido,
          pai: PAI_FANTASMA,
          n: 1111,
          a: { r: MOTIVO_RETENCAO_PRECO_LI.paiAusente },
        });

        // The price root: this run's state over another run's, and the end with the RUN's tabelas.
        const raiz = (await db().doc(RAIZ_PRECO_PATH).get()).data();
        const tabelas = { normal: TAB_N, promocional: TAB_P };
        expect(raiz?.execucaoPreco).toMatchObject({ execucaoId: RUN, tabelas });
        expect(raiz?.execucaoPreco?.amostras?.retido).toEqual(
          expect.arrayContaining([SEM_PRECO, FANTASMA]),
        );
        expect(typeof run?.iniciadoEmMs).toBe('number');
        expect(raiz?.ultimoReconcilePreco).toMatchObject({
          execucaoId: RUN,
          iniciadoEmMs: run?.iniciadoEmMs,
          tabelas,
          contadores: {
            pais: 1,
            validos: 6,
            paisLidos: 3,
            paisAusentes: 1,
            alvos: 4,
            limpezas: 1,
            retidos: 2,
            retidosSemPreco: 1,
            retidosSemPai: 1,
            paisConcluido: 1,
          },
        });
        expect(raiz?.ultimoReconcilePreco?.contadores).not.toHaveProperty('armaFalhou');
        expect(raiz?.reconcilePreco ?? null).toBeNull();

        // Under `dry-run` no aviso is read or written: ONE INFO line says what it would raise.
        for (const chave of chavesDosAvisos()) {
          expect((await db().collection('avisos').doc(chave).get()).exists, chave).toBe(false);
        }
        const achados = log.linhas.filter(
          (l) => l.msg.includes('achado de preço da conta (sem aviso)') && l.meta.contaId === CONTA,
        );
        expect(achados).toHaveLength(1);
        expect(achados[0]?.meta).toMatchObject({ produtos: 2 });
        expect(
          log.linhas.filter(
            (l) => l.msg.includes('alvos da conta calculados') && l.meta.contaId === CONTA,
          ),
        ).toHaveLength(1);
        expect(log.linhas.filter((l) => l.nivel === 'error')).toEqual([]);
        // The price slot is a later phase's: this side never touches it.
        expect((await db().doc(SLOT_PRECO_PATH).get()).exists).toBe(false);
      },
    );

    it(
      'BOTH arms in one walk (stock dry-run, price dry-run): each page’s produtos read ONCE through the union mask, the stock store phase stopped at the read switch, both ends written',
      { timeout: 240_000 },
      async () => {
        expect(process.env[VALVULA_ENV_LI.estoque]).not.toBe('on');
        await semearConta();
        await semearProduto(
          PAI_A,
          { precos: { [TAB_N]: preco(55.55), [TAB_P]: preco(44.44) } },
          LINK_PAI,
        );
        await semearProduto(
          FILHO_A1,
          { paiId: PAI_A, precos: { [TAB_N]: preco(33.33) } },
          linkFilho(ID.a1),
        );
        await semearProduto(RAIZ, { precos: { [TAB_N]: preco(77.77) } }, linkFilho(ID.raiz));

        const relogio = { agora: AGORA_RECONCILE_MS };
        const observado = firestoreObservado(db(), relogio, 12_000);
        const { resultados, log } = await cadeia(observado.db, relogio, {
          [VALVULA_ENV_LI.estoque]: MODO_LI.dryRun,
          [VALVULA_ENV_LI.preco]: MODO_LI.dryRun,
        });
        expect(resultados.at(-1)).toEqual({ kind: 'encerrado' });

        const run = (await db().doc(RUN_PATH).get()).data();
        expect(run?.contas, 'outra conta com depósito ficou no emulador').toEqual([CONTA]);
        expect(run).toMatchObject({ fase: FASE_RECONCILE_ESTOQUE_LI.fim, emExecucaoAteMs: 0 });
        expect(run?.contadores).toMatchObject({ precoNoRun: 1, c0ChamadasDesligadas: 1 });
        expect(run?.contadores).not.toHaveProperty('estoqueForaDoRun');

        // The walk read each produto ONCE, through the union mask; the parents phase through the
        // price mask. The server answered those fields only.
        const uniao = [
          ...new Set<string>([...CAMPOS_PRODUTO_ESTOQUE_LI, ...CAMPOS_PRODUTO_PRECO_LI]),
        ];
        const deProdutos = getAllsDeProdutos(observado.getAlls);
        const daCaminhada = deProdutos.filter((g) => g.mascara?.length === uniao.length);
        const dosPais = deProdutos.filter((g) => g.mascara?.length !== uniao.length);
        expect(daCaminhada.length).toBeGreaterThan(0);
        for (const g of daCaminhada) {
          expect(g.mascara).toEqual(uniao);
          for (const campos of g.campos) for (const campo of campos) expect(uniao).toContain(campo);
        }
        const lidosNaCaminhada = daCaminhada.flatMap((g) => g.caminhos);
        for (const produtoId of [FILHO_A1, RAIZ]) {
          expect(lidosNaCaminhada.filter((c) => c === `produtos/${produtoId}`)).toHaveLength(1);
        }
        expect(dosPais.map((g) => g.caminhos)).toEqual([[`produtos/${PAI_A}`]]);
        expect(dosPais[0]?.mascara).toEqual([...CAMPOS_PRODUTO_PRECO_LI]);

        // Both snapshots from the one walk: the stock entries and the price targets.
        const entradaEstoque = async (idLi: number) => {
          const id = baldeSnapshotEstoqueLi(String(idLi)) ?? '';
          const snap = await db().doc(`${RAIZ_ESTOQUE_PATH}/snapshot/${id}`).get();
          return (snap.data()?.e as Record<string, unknown> | undefined)?.[String(idLi)];
        };
        expect(await entradaEstoque(ID.a1)).toMatchObject({ p: FILHO_A1 });
        expect(await entradaEstoque(ID.raiz)).toMatchObject({ p: RAIZ });
        const entrada = async (idLi: number) =>
          ((await balde(idLi))?.e as Record<string, unknown> | undefined)?.[String(idLi)];
        expect(await entrada(ID.a1)).toMatchObject({ a: { c: 5555, q: 4444 } });
        expect(await entrada(ID.raiz)).toMatchObject({ a: { c: 7777, q: null } });

        // Both ends: the stock one and the price one, for the same run.
        const raizEstoque = (await db().doc(RAIZ_ESTOQUE_PATH).get()).data();
        expect(raizEstoque?.ultimoReconcile).toMatchObject({ execucaoId: RUN });
        const raizPreco = (await db().doc(RAIZ_PRECO_PATH).get()).data();
        expect(raizPreco?.ultimoReconcilePreco).toMatchObject({
          execucaoId: RUN,
          contadores: { validos: 2, alvos: 2, paisLidos: 1, paisConcluido: 1 },
        });
        expect(log.linhas.filter((l) => l.nivel === 'error')).toEqual([]);
      },
    );
  },
);
