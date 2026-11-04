/**
 * The order poller into the reads queue, end to end, against the real emulators
 * (`ci-loja-integrada.yml`).
 *
 * What runs for real here:
 *
 *   executarPollPedidosLi(db, deps)          the real tick, in THIS process
 *     → listarContasLojaIntegrada            the real enumeration (emulator)
 *     → loadLojaIntegradaContext             the real context: conta, credential
 *     → paginarLi over the package client    against a SCRIPTED platform (deps.fetch)
 *     → the lease, then the final write      on the real poll document
 *     → criarAgendadorLiDoAmbiente()         the real producer root of the codebase
 *       → the region-qualified queue → Cloud Tasks emulator → Functions emulator
 *       → filaLeituraLojaIntegrada           the real deployed onTaskDispatched
 *       → its context refuses on the READ SWITCH (the job env sets it `off`)
 *       → `adiado/chamadas-desligadas` → a `deferred` row per order
 *
 * The importer gate is bound as the root binds it, from the REAL seam
 * (`importadorPedidoLi() !== null`): step 5 filled it with the order import, so
 * the tick passes the gate — and the dispatched function, which carries that
 * same importer, still stops at its switch before the importer starts.
 *
 * ⚠️ The switch is ON in one process and OFF in the other, and that is the
 * point. The poller runs here with `ambiente` handed in as a PARAMETER —
 * `{ LOJA_INTEGRADA_CHAMADAS: 'on' }` — so its context passes the switch and its
 * client calls the platform through `deps.fetch`, a scripted answer built from
 * the public document's two example rows. `process.env` is never touched: the
 * setup refuses to start when the variable is `on` there, because the
 * functions emulator inherits this shell's environment and the DISPATCHED
 * function must stop at the switch — the setup's fetch kill-switch does not
 * reach that process. So the dispatched run refuses before any read, by call
 * order, and still PERSISTS its outcome: the assertions are about documents a
 * different process wrote.
 *
 * What this proves that the offline suite cannot:
 *   - the payload the poller builds survives the real queue hop and is accepted
 *     by the deployed handler's schema (a `deferred` row per example row, with
 *     the doc id spelled out below — numero and the stamp's digits intact);
 *   - the poller's own producer root resolves the region-qualified queue the
 *     artifact registers (a mismatch is the silent drop of #1108: the wait
 *     times out instead of failing);
 *   - the enumeration, the context, the lease and the final write run against
 *     a real Firestore: the cursor and `vistos` are STORED, the lease released.
 *
 * ⚠️ NOT covered: the importer's own run (it needs the switch on in the
 * dispatched process, which this lane never turns on — its emulator proof is
 * `importarPedido.firestore.test.ts`, in process), `onSchedule` (the emulator
 * ignores it without pubsub), and any real platform call (D17).
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';
import {
  INTEGRACAO_TIPO,
  NOTIFICACAO_RESILIENCIA_STATUS,
  ORIGEM_NOTIFICACAO_LI,
  TIPO_TAREFA_LI,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { criarAgendadorLiDoAmbiente } from '../../../functions/src/agendador';
import { CHAMADAS_ENV_LI } from '../core/valvulas';
import { importadorPedidoLi } from '../notificacoes/notificacao';
import { AMBIENTE_LIGADO, credencialDoc, gravadorDeLog, loggerEspiao } from '../testing/fixtures';
import { type DepsPollLi, executarPollPedidosLi } from './pollPedidos';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const NOTIF = 'notificacoesLojaIntegrada';
const CONTAS = 'integracao';
const POLL = 'pollPedidosLojaIntegrada';
const AVISOS = 'avisos';

/** An obviously fake conta id, distinct from the other emulator suites' ids. */
const CONTA_ID = 'conta-li-poll-ci';

/**
 * 2022-10-31T15:30:00Z — 12:30 in São Paulo (UTC−3, no daylight saving since
 * 2019): just after the example rows' stamps, so a CURSORLESS conta's
 * first tick takes them in its 72 h bootstrap window. The first lease therefore
 * `create`s the poll document here, as at the window's first tick.
 */
const AGORA_MS = Date.UTC(2022, 9, 31, 15, 30, 0);

/** The public document's two example rows (`GET /v1/pedido/search`), verbatim stamps. */
const EXEMPLO_164 = {
  numero: 164,
  data_modificacao: '2022-10-31T12:17:58.949670',
  resource_uri: '/api/v1/pedido/164',
};
const EXEMPLO_165 = {
  numero: 165,
  data_modificacao: '2022-10-31T12:28:12.653648',
  resource_uri: '/api/v1/pedido/165',
};

/**
 * The window the first tick asks for, spelled out: the bootstrap bound
 * `AGORA_MS − 72 h` in São Paulo time (2022-10-28T12:30:00) minus the
 * 4 h 02 min overlap.
 */
const URL_ESPERADA = `${URL_BASE_LI}/v1/pedido/search/?since_atualizado=2022-10-28T08%3A28%3A00&limit=50`;

/** `<conta>:<numero>:<origem>:<the stamp's digits>` — spelled out, not derived from the code under test. */
const ID_164 = `${CONTA_ID}:164:poll:20221031121758949670`;
const ID_165 = `${CONTA_ID}:165:poll:20221031122812653648`;

function db(): Firestore {
  return getAdminFirestore();
}

function aguardar(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll for the row the DISPATCHED function writes: there is no promise to
 * await across the queue hop, only the effect — and waiting on it is also what
 * keeps `emulators:exec` from tearing the dispatch down mid-flight.
 */
async function aguardarDocumento(
  docId: string,
  timeoutMs = 45_000,
): Promise<FirebaseFirestore.DocumentData> {
  const prazo = Date.now() + timeoutMs;
  for (;;) {
    const snap = await db().collection(NOTIF).doc(docId).get();
    if (snap.exists) return snap.data() ?? {};
    if (Date.now() > prazo) {
      const todos = await db().collection(NOTIF).get();
      throw new Error(
        `a notificação ${docId} não chegou em ${String(timeoutMs)}ms. ` +
          `A coleção tem ${String(todos.size)} doc(s): ${todos.docs.map((d) => d.id).join(', ') || '<vazia>'}. ` +
          'O poller enfileirou (o resultado do tick diz quantas) e nada chegou: o Cloud ' +
          'Tasks aceitou e nunca entregou — o descarte silencioso de região do #1108. ' +
          'Confira que LOJA_INTEGRADA_TASKS_REGION é igual ao FUNCTIONS_REGION embutido no ' +
          'bundle e que prepare-deploy.mjs rodou antes do emulators:exec.',
      );
    }
    await aguardar(250);
  }
}

async function limpar(): Promise<void> {
  for (const colecao of [NOTIF, CONTAS, POLL, AVISOS]) {
    await db().recursiveDelete(db().collection(colecao));
  }
}

describe.skipIf(!EMULATED || !TASKS)(
  'o poller de pedidos da Loja Integrada → fila de leitura → onTaskDispatched',
  () => {
    /** Every request that reached the GLOBAL fetch — the scripted platform is `deps.fetch`. */
    const redeGlobal: string[] = [];

    beforeAll(() => {
      // Initialise the admin app FIRST, with the project the setup pinned: the
      // producer root's `getAdminApp()` reuses the default app.
      db();
    });

    beforeEach(async () => {
      __resetAllReadCaches();
      await limpar();
      // An ACTIVE Loja Integrada conta with a usable credential and NO poll
      // document: the context passes, and the first lease creates the document.
      const conta = db().collection(CONTAS).doc(CONTA_ID);
      await conta.set({ tipo: INTEGRACAO_TIPO.lojaIntegrada, nome: 'Loja de teste', ativo: true });
      await conta.collection('credenciaisLojaIntegrada').doc('current').set(credencialDoc());

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

    afterEach(() => {
      vi.unstubAllGlobals();
      __resetAllReadCaches();
      // Loja Integrada was reached ONLY through the scripted `deps.fetch`.
      const plataforma = new URL(URL_BASE_LI).hostname;
      const vazadas = redeGlobal.filter((u) => new URL(u).hostname === plataforma);
      redeGlobal.length = 0;
      expect(vazadas).toEqual([]);
    });

    afterAll(async () => {
      await limpar();
    });

    it('the spec rows → the real enqueue → the dispatched function (switch off) writes two `deferred` rows; the cursor and vistos are stored', async () => {
      // The emulator process must see the switch OFF; this process passes it ON
      // as a parameter only.
      expect(process.env[CHAMADAS_ENV_LI]).not.toBe('on');

      const urls: string[] = [];
      const esperas: number[] = [];
      const gravador = gravadorDeLog();
      const espiao = loggerEspiao();
      const plataformaFalsa: typeof globalThis.fetch = (input) => {
        urls.push(String(input));
        const corpo = {
          meta: { limit: 15, offset: 0, next: null, previous: null, total_count: 2 },
          objects: [EXEMPLO_164, EXEMPLO_165],
        };
        return Promise.resolve(
          new Response(JSON.stringify(corpo), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      };
      const deps: DepsPollLi = {
        // ON as a PARAMETER — never through process.env (header).
        ambiente: AMBIENTE_LIGADO,
        // The REAL seam, as the root binds it — never a hard-coded `true`.
        importadorPresente: importadorPedidoLi() !== null,
        lookbackHoras: 72,
        agendador: criarAgendadorLiDoAmbiente(),
        agoraMs: () => AGORA_MS,
        esperar: (ms) => {
          esperas.push(ms);
          return Promise.resolve();
        },
        increment: (by) => FieldValue.increment(by),
        gerarExecucaoId: () => 'exec-poll-ci',
        logger: espiao.logger,
        escrever: gravador.escrever,
        fetch: plataformaFalsa,
      };

      const r = await executarPollPedidosLi(db(), deps);

      expect(r).toEqual({
        portao: null,
        contas: [
          {
            integracaoId: CONTA_ID,
            desfecho: 'sucesso',
            motivo: null,
            // Both on the real queue — none persisted for the sweep instead.
            enfileiradas: 2,
            persistidas: 0,
            paginas: 1,
            cursorAvancou: true,
            codigoGrpc: null,
          },
        ],
      });
      expect(urls).toEqual([URL_ESPERADA]);
      expect(esperas).toEqual([2000]);

      // The cursor and vistos are STORED, and the lease released.
      const poll = await db().collection(POLL).doc(CONTA_ID).get();
      expect(poll.exists).toBe(true);
      expect(poll.data()).toEqual({
        cursor: '2022-10-31T12:28:12',
        emExecucaoAteMs: 0,
        execucaoId: null,
        ultimaVarreduraEmMs: AGORA_MS,
        ultimoErro: null,
        falhasSeguidas: 0,
        vistos: {
          '164': '2022-10-31T12:17:58.949670',
          '165': '2022-10-31T12:28:12.653648',
        },
      });

      // The deployed handler took each payload and refused at ITS switch.
      for (const [docId, numero, carimbo] of [
        [ID_164, '164', '2022-10-31T12:17:58.949670'],
        [ID_165, '165', '2022-10-31T12:28:12.653648'],
      ] as const) {
        const doc = await aguardarDocumento(docId);
        expect(doc).toMatchObject({
          tipo: TIPO_TAREFA_LI.pedido,
          contaId: CONTA_ID,
          numero,
          origem: ORIGEM_NOTIFICACAO_LI.poll,
          dataModificacaoLi: carimbo,
          // `deferred` at the switch, not `failed`: had the poller PERSISTED the
          // row itself (a transient enqueue), it would be `failed` with no
          // processedAt from the handler.
          status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
          tentativas: 0,
          erro: 'adiado/chamadas-desligadas',
        });
        expect(doc.processedAt).toBeGreaterThan(0);
      }
      // Exactly the two rows: no stray document for anything else.
      const todos = await db().collection(NOTIF).get();
      expect(todos.docs.map((d) => d.id).sort()).toEqual([ID_164, ID_165]);

      // One poll line for the conta's run, and no aviso was raised.
      expect(
        gravador.linhas.filter((l) => l.campos.evento === 'poll').map((l) => l.campos.desfecho),
      ).toEqual(['sucesso']);
      expect((await db().collection(AVISOS).get()).empty).toBe(true);
      expect(espiao.chamadas).toEqual([]);
    });
  },
);
