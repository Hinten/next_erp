/**
 * The daily stock reconcile (master plan step 12, PR 12-g) against the REAL emulators
 * (`ci-loja-integrada.yml`), in two cases.
 *
 * 1. **The chain, IN PROCESS** (the `processarEstoque.tasks.test.ts` precedent): every slice run by
 *    THIS process (`despacharReconcileEstoqueLi`), its hand-offs recorded and driven by hand — so no
 *    deployed reads-queue dispatch drives the same lease at once — the valve, the canary and the
 *    read switch ON as a PARAMETER (never `process.env`), the store SCRIPTED (`deps.fetch`), the
 *    stock sends through the REAL producer root (`criarAgendadorEstoqueLiDoAmbiente`):
 *      - the key walk with a full-path `startAfter`, ordered by key segment by segment (`p` before
 *        `p-1`, which a raw string order inverts), at 2 links a page;
 *      - the links' odd forms: a conta ref with a leading slash, a bare one, a TEXT store id;
 *      - the records: a canonical one, a legacy record with NO `parentId` at the BARE depósito ref
 *        (only the own-collection query finds it), 0 here beside 40 at another depósito (S 0),
 *        none at all (held, after the never-had-stock listing);
 *      - a kit, its composition kept on its entry and its inline kits header written;
 *      - the store's list (3 pages), a row no entry names looked up on the declared index and FOUND
 *        (a link created after the walk, TEXT id), one found nowhere (`x`);
 *      - the queue phase: the over-advertising rows, each enqueued on the global slot (the
 *        reservation writes the run document, so the slice's checkpoint meets a REAL 9 and
 *        re-applies its batch) and ACCEPTED by the Cloud Tasks emulator;
 *      - the end: the held aviso raised, `ultimoReconcile`, the lease released.
 * 2. **The depósito-change arm, DISPATCHED**: updating the suite's own conta's depósito fires the
 *    DEPLOYED conta trigger, which enqueues ONE named run; the deployed reads queue runs it to its
 *    end. With the lane's read switch off, every conta's store phase stops at the switch, so the
 *    observable is the run document (`fase: fim`, the lease released) and the conta's
 *    `ultimoReconcile`. That a CREATE never fires is proved OFFLINE only
 *    (`functions/src/onIntegracaoLojaIntegradaChanged.test.ts`): a create-fired run would finish
 *    in seconds here and the update's run would take the free lease anyway.
 *
 * Isolation (`vitest.tasks.config.ts`, the sixth rule set): conta, depósito and produto ids no
 * other suite seeds; the run document is wiped before AND after every case (the kit fan-out's slot
 * shares it, and `gatilhoEstoque.tasks.test.ts` asserts it exactly); every link create's anchor
 * write awaited; the teardown deletes the conta's sync documents (its kits headers) FIRST, then
 * the links (the anchor's last write awaited), the records, the produtos, the conta, its avisos.
 * Every record written also fires the deployed stock trigger, at the lane's `dry-run` valve: it may
 * enqueue send runs (they stop at their write context and write nothing); the kits header is
 * INLINE, so no fan-out (no slot write) ever follows.
 *
 * NOT proven here: the declared indexes and the scan cost on Enterprise (pinned offline against
 * `firestore.indexes.json`), Cloud Scheduler, the tasks' schedule times (ignored by the emulator),
 * named-task dedup, and any real store call (none before the cutover).
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';
import {
  FASE_RECONCILE_ESTOQUE_LI,
  FLAG_ENTRADA_ESTOQUE_LI,
  INTEGRACAO_TIPO,
  MOTIVO_ESTOQUE_VINCULO_LI,
  TIPO_AVISO,
  TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  baldeSnapshotEstoqueLi,
  chaveDeAviso,
  makeEstoqueUid,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { criarAgendadorEstoqueLiDoAmbiente } from '../../../../functions/src/agendadorEstoque';
import { CANARIO_ENV_LI, CHAMADAS_ENV_LI, MODO_LI, VALVULA_ENV_LI } from '../../core/valvulas';
import { aguardarAncoraLi, comConta, semConta } from '../../testing/ancoraLi';
import { credencialDoc, gravadorDeLog } from '../../testing/fixtures';
import { criarPlataformaEscritaLi, linhaEstoqueLi } from '../../testing/plataformaEscritaLi';
import {
  AGORA_RECONCILE_MS,
  agendadorGravador,
  componentesDoKit,
  loggerGravador,
} from '../../testing/reconcileEstoqueLi';
import { LIMITE_PAGINA_ESTOQUE_ENV_LI } from '../configEstoqueLi';
import { type DepsReconcileEstoqueLi, despacharReconcileEstoqueLi } from './despachoReconcile';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

/** Obviously fake ids, distinct from every other emulator suite's. */
const CONTA = 'conta-li-reconcile-ci';
const DEP = 'dep-li-reconcile-ci';
const OUTRO_DEP = 'dep-li-reconcile-ci-outro';
const CONTA_ARM = 'conta-li-reconcile-dep-ci';
const DEP_ARM_1 = 'dep-li-reconcile-arm-1';
const DEP_ARM_2 = 'dep-li-reconcile-arm-2';
const RUN = 'estoque-reconcile-ci-emulador';
const RUN_PATH = 'reconcileEstoqueLojaIntegrada/atual';

/** `p` and `p-1`: the key order puts `produtos/p/…` FIRST; a raw string order would not. */
const PROD_A = 'pr-li-rec-ci';
const PROD_B = 'pr-li-rec-ci-1';
const PROD_C = 'pr-li-rec-ci-2';
const PROD_D = 'pr-li-rec-ci-3';
const KIT = 'pr-li-rec-ci-kit';
const TARDIO = 'pr-li-rec-ci-tardio';
const PRODUTOS = [PROD_A, PROD_B, PROD_C, PROD_D, KIT, TARDIO] as const;

const ID = { p: 9101, p1: 9102, p2: 9103, p3: 9104, kit: 9105, tardio: 9107, orfao: 9199 };

function db(): Firestore {
  return getAdminFirestore();
}

async function aguardar(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Polls `caminho` until `pronto` holds (a POSITIVE state only), within `prazoMs`. */
async function aguardarDoc(
  caminho: string,
  pronto: (dados: FirebaseFirestore.DocumentData | undefined) => boolean,
  prazoMs = 90_000,
): Promise<FirebaseFirestore.DocumentData | undefined> {
  const fim = Date.now() + prazoMs;
  for (;;) {
    const dados = (await db().doc(caminho).get()).data();
    if (pronto(dados)) return dados;
    if (Date.now() > fim) {
      throw new Error(`${caminho} não chegou ao estado esperado: ${JSON.stringify(dados)}`);
    }
    await aguardar(500);
  }
}

/** The avisos this suite's contas can raise, by id. */
function chavesDosAvisos(conta: string): string[] {
  return [
    chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaEstoqueSemErp, conta }),
    ...Object.values(MOTIVO_ESTOQUE_VINCULO_LI).map((motivo) =>
      chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaEstoqueVinculo, conta, entidade: motivo }),
    ),
  ];
}

async function limpar(): Promise<void> {
  // The sync documents FIRST: the kits headers (a record delete under a header is a trigger read).
  for (const conta of [CONTA, CONTA_ARM]) {
    await db().recursiveDelete(db().collection('sincEstoqueLojaIntegrada').doc(conta));
  }
  await db().doc(RUN_PATH).delete();
  for (const produtoId of PRODUTOS) {
    const ref = db().collection('produtos').doc(produtoId);
    const links = await ref.collection('produtolojaintegrada').get();
    for (const link of links.docs) await link.ref.delete();
    if (!links.empty && (await ref.get()).exists) {
      await aguardarAncoraLi(db(), produtoId, semConta(CONTA), `sem a conta (${produtoId})`);
    }
    await db().recursiveDelete(ref);
  }
  for (const conta of [CONTA, CONTA_ARM]) {
    await db().recursiveDelete(db().collection('integracao').doc(conta));
    for (const chave of chavesDosAvisos(conta)) await db().collection('avisos').doc(chave).delete();
  }
}

async function semearProduto(
  produtoId: string,
  produto: FirebaseFirestore.DocumentData,
  registros: Readonly<Record<string, FirebaseFirestore.DocumentData>>,
  link: FirebaseFirestore.DocumentData | null,
): Promise<void> {
  const ref = db().collection('produtos').doc(produtoId);
  await ref.set({ sku: `SKU-${produtoId}`, ...produto });
  for (const [id, dados] of Object.entries(registros)) {
    await ref.collection('estoques').doc(id).set(dados);
  }
  if (link !== null) {
    await ref.collection('produtolojaintegrada').doc('l1').set(link);
    await aguardarAncoraLi(db(), produtoId, comConta(CONTA), `com a conta (${produtoId})`);
  }
}

const link = (id: number | string, contaRef = `documents/integracao/${CONTA}`) => ({
  contaLojaIntegrada: contaRef,
  id,
  paiProdutoIntegradaId: 900_001,
  removido: false,
});
const canonico = (produtoId: string, dep: string, quantidade: number) => ({
  [makeEstoqueUid(produtoId, dep)]: {
    parentId: produtoId,
    depositoOuterRef: `documents/depositos/${dep}`,
    quantidade,
  },
});

describe.skipIf(!EMULATED || !TASKS)('the daily stock reconcile against the emulators', () => {
  const redeGlobal: string[] = [];

  beforeAll(() => {
    db();
  });

  beforeEach(async () => {
    __resetAllReadCaches();
    await limpar();
    const anterior = globalThis.fetch;
    vi.stubGlobal('fetch', (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      redeGlobal.push(url);
      return anterior(input, init);
    });
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
    'IN PROCESS: the walk, the joins, the snapshot and kits map, the store’s list with a lookup, the queue on the global slot, the end — one chain',
    { timeout: 240_000 },
    async () => {
      expect(process.env[CHAMADAS_ENV_LI]).not.toBe('on');
      expect(process.env[VALVULA_ENV_LI.estoque]).not.toBe('on');
      const conta = db().collection('integracao').doc(CONTA);
      await conta.set({
        tipo: INTEGRACAO_TIPO.lojaIntegrada,
        nome: 'Loja reconcile CI',
        ativo: true,
        depositoOuterRef: `documents/depositos/${DEP}`,
      });
      await conta.collection('credenciaisLojaIntegrada').doc('current').set(credencialDoc());
      // PROD_A: canonical record, link under a conta ref with a LEADING slash.
      await semearProduto(
        PROD_A,
        {},
        canonico(PROD_A, DEP, 5),
        link(ID.p, `/documents/integracao/${CONTA}`),
      );
      // PROD_B: a LEGACY record with no parentId at the BARE depósito ref; a bare conta ref; a TEXT id.
      await semearProduto(
        PROD_B,
        {},
        { 'legado-ci': { depositoOuterRef: `depositos/${DEP}`, quantidade: 3 } },
        link(String(ID.p1), `integracao/${CONTA}`),
      );
      // PROD_C: 0 at the conta's depósito and 40 at ANOTHER one ⇒ S 0 (the other depósito never
      // counts). Not a record ELSEWHERE ONLY: with 4 evaluated children that one would trip the
      // safety gate and the conta would send nothing (`filaReconcile.test.ts` pins the gate).
      await semearProduto(
        PROD_C,
        {},
        { ...canonico(PROD_C, DEP, 0), ...canonico(PROD_C, OUTRO_DEP, 40) },
        link(ID.p2),
      );
      // PROD_D: no record anywhere ⇒ held.
      await semearProduto(PROD_D, {}, {}, link(ID.p3));
      // A kit of PROD_A (one per kit): its S from PROD_A's 5, its own record never read.
      await semearProduto(
        KIT,
        { ehKit: true, componentesKit: componentesDoKit({ [PROD_A]: 1 }) },
        {},
        link(ID.kit),
      );

      const p = criarPlataformaEscritaLi({
        estoque: [
          linhaEstoqueLi(ID.p, { quantidade: 5 }),
          linhaEstoqueLi(ID.p1, { quantidade: 10 }),
          linhaEstoqueLi(ID.p2, { quantidade: 4 }),
          linhaEstoqueLi(ID.p3, { quantidade: 7 }),
          linhaEstoqueLi(ID.kit, { quantidade: 5 }),
          linhaEstoqueLi(ID.tardio, { quantidade: 9 }),
          linhaEstoqueLi(ID.orfao, { quantidade: 1 }),
        ],
      });
      const fila = agendadorGravador();
      const log = loggerGravador();
      const relogio = { agora: AGORA_RECONCILE_MS };
      // The kits map done ends the ERP side: the clock jumps past the budget, so the slice ends
      // right there — before the store phase reads anything — and the test can act in between.
      const logger = {
        ...log.logger,
        info: (msg: string, meta?: Record<string, unknown>) => {
          log.logger.info(msg, meta);
          if (msg.endsWith('mapa de kits da conta concluído')) relogio.agora += 200_000;
        },
      };
      const deps = (): DepsReconcileEstoqueLi => ({
        ambiente: {
          [CHAMADAS_ENV_LI]: MODO_LI.on,
          [VALVULA_ENV_LI.estoque]: MODO_LI.on,
          [CANARIO_ENV_LI.estoque]: '*',
          [LIMITE_PAGINA_ESTOQUE_ENV_LI]: '3',
        },
        agoraMs: () => relogio.agora,
        inicioMs: relogio.agora,
        tentativa: 0,
        idTarefa: null,
        esperar: p.esperar,
        increment: (by) => FieldValue.increment(by),
        agendador: () => fila.agendador,
        agendadorEstoque: criarAgendadorEstoqueLiDoAmbiente,
        logger,
        fetch: p.fetch,
        escrever: gravadorDeLog().escrever,
        tamanhoPaginaCaminhada: 2,
      });
      const slice = (seq: number) =>
        despacharReconcileEstoqueLi(
          db(),
          { tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI, execucaoId: RUN, seq },
          deps(),
        );

      // Until the store phase: the ERP walk and the kits map.
      let seq = 0;
      let r = await slice(seq);
      for (
        let n = 0;
        n < 30 && r.kind === 'continua' && r.fase === FASE_RECONCILE_ESTOQUE_LI.erp;
        n += 1
      ) {
        seq = r.seq;
        relogio.agora += 2_000;
        r = await slice(seq);
      }
      const run = (await db().doc(RUN_PATH).get()).data();
      // Nothing else in the emulator is a conta of this run — else every counter below misleads.
      expect(run?.contas, 'outra conta com depósito ficou no emulador').toEqual([CONTA]);
      const entrada = async (id: number) => {
        const balde = baldeSnapshotEstoqueLi(String(id)) ?? '';
        const snap = await db().doc(`sincEstoqueLojaIntegrada/${CONTA}/snapshot/${balde}`).get();
        return (snap.data()?.e as Record<string, unknown> | undefined)?.[String(id)];
      };
      expect(await entrada(ID.p)).toEqual({ p: PROD_A, s: 5, f: FLAG_ENTRADA_ESTOQUE_LI.valido });
      expect(await entrada(ID.p1)).toEqual({ p: PROD_B, s: 3, f: FLAG_ENTRADA_ESTOQUE_LI.valido });
      expect(await entrada(ID.p2)).toEqual({ p: PROD_C, s: 0, f: FLAG_ENTRADA_ESTOQUE_LI.valido });
      expect(await entrada(ID.p3)).toEqual({
        p: PROD_D,
        s: null,
        f: FLAG_ENTRADA_ESTOQUE_LI.retido,
      });
      expect(await entrada(ID.kit)).toMatchObject({
        p: KIT,
        s: 5,
        k: true,
        q: { [PROD_A]: 1 },
        e: { [PROD_A]: makeEstoqueUid(PROD_A, DEP) },
      });
      const cabecalho = (
        await db().doc(`sincEstoqueLojaIntegrada/${CONTA}/kits/${PROD_A}`).get()
      ).data();
      expect(cabecalho).toMatchObject({
        execucaoId: RUN,
        F: 1,
        qMax: 1,
        fatias: 0,
        comps: { [PROD_A]: makeEstoqueUid(PROD_A, DEP) },
        kits: { [KIT]: { i: String(ID.kit), q: { [PROD_A]: 1 } } },
      });

      // A link created AFTER the walk: its row has no entry, the lookup finds it (TEXT id).
      await semearProduto(TARDIO, {}, canonico(TARDIO, DEP, 2), link(String(ID.tardio)));

      for (let n = 0; n < 60 && r.kind === 'continua'; n += 1) {
        seq = r.seq;
        relogio.agora += 2_000;
        r = await slice(seq);
      }
      expect(r).toEqual({ kind: 'encerrado' });

      const fim = (await db().doc(RUN_PATH).get()).data();
      expect(fim).toMatchObject({
        execucaoId: RUN,
        fase: FASE_RECONCILE_ESTOQUE_LI.fim,
        emExecucaoAteMs: 0,
        candidatos: [],
      });
      // The three rows out of step — PROD_B (10 vs 3), PROD_C (4 vs 0), the late link (9 vs 2) — were
      // enqueued, each accepted by the Cloud Tasks emulator through the real producer root; the held
      // PROD_D and the in-step rows were not.
      expect(fim?.contadores).not.toHaveProperty('c0BloqueadoDeposito');
      expect(fim?.contadores).toMatchObject({
        c0Enfileirados: 3,
        c0LinhasRetidas: 1,
        reservasSlot: 1,
      });
      expect(typeof fim?.proximoSlotMs).toBe('number');
      expect(await entrada(ID.tardio)).toEqual({
        p: TARDIO,
        s: 2,
        f: FLAG_ENTRADA_ESTOQUE_LI.valido,
      });
      expect(await entrada(ID.orfao)).toEqual({
        p: null,
        s: null,
        f: FLAG_ENTRADA_ESTOQUE_LI.semVinculo,
      });
      // The held aviso, raised under on, clocked by the run's start.
      const semErp = (
        await db()
          .collection('avisos')
          .doc(chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaEstoqueSemErp, conta: CONTA }))
          .get()
      ).data();
      expect(semErp).toMatchObject({ params: { produtos: 1, amostra: PROD_D }, resolvidoEm: null });
      const raiz = (await db().doc(`sincEstoqueLojaIntegrada/${CONTA}`).get()).data();
      expect(raiz).toMatchObject({ reconcile: null, ultimoReconcile: { execucaoId: RUN } });
      // Every store call went through the scripted fetch, three list pages and no detail GET.
      expect(
        p.chamadasComBusca().filter((c) => c.startsWith('GET /v1/produto_estoque?')),
      ).toHaveLength(3);
    },
  );

  it(
    'DISPATCHED: re-pointing a conta’s depósito (an UPDATE) runs ONE full reconcile to its end; with the read switch off its store phase stops there',
    { timeout: 180_000 },
    async () => {
      const conta = db().collection('integracao').doc(CONTA_ARM);
      await conta.set({
        tipo: INTEGRACAO_TIPO.lojaIntegrada,
        nome: 'Loja deposito CI',
        ativo: true,
        depositoOuterRef: `documents/depositos/${DEP_ARM_1}`,
      });
      await conta.update({ depositoOuterRef: `documents/depositos/${DEP_ARM_2}` });

      const run = await aguardarDoc(
        RUN_PATH,
        (d) =>
          typeof d?.execucaoId === 'string' &&
          d.execucaoId.startsWith('estoque-reconcile-deposito-') &&
          d.fase === FASE_RECONCILE_ESTOQUE_LI.fim &&
          d.emExecucaoAteMs === 0,
      );
      expect(run?.contas, 'outra conta com depósito ficou no emulador').toEqual([CONTA_ARM]);
      expect(run?.contadores).toMatchObject({ c0ChamadasDesligadas: 1 });
      const raiz = await aguardarDoc(
        `sincEstoqueLojaIntegrada/${CONTA_ARM}`,
        (d) => d?.ultimoReconcile?.execucaoId === run?.execucaoId,
      );
      expect(raiz?.execucao).toMatchObject({ depositoId: DEP_ARM_2 });
    },
  );
});
