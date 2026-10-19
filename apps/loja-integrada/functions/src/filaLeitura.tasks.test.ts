/**
 * The reads-queue Cloud Tasks hop, end to end, against the real emulators
 * (`ci-loja-integrada.yml`).
 *
 * What runs for real here, with nothing mocked:
 *
 *   criarAgendadorLiDoAmbiente().enfileirar(payload)   the real producer root
 *     → the real region-qualified queue path
 *     → Cloud Tasks emulator → Functions emulator
 *     → filaLeituraLojaIntegrada                       the real deployed onTaskDispatched
 *     → tratarTarefaLeituraLi → the notification pipeline
 *     → loadLojaIntegradaContext refuses on the READ SWITCH
 *     → `adiado/chamadas-desligadas` → `defer`
 *     → a real `deferred` doc in notificacoesLojaIntegrada
 *
 * ⚠️ Why the switch refusal, and not a happier path. The lane's non-localhost
 * `fetch` kill-switch lives in the VITEST process and does NOT cover the
 * dispatched function, which runs in the emulator's own process — so any path
 * that reached a client would be a call the runner could really make. This one
 * cannot: the context loader checks `LOJA_INTEGRADA_CHAMADAS` as its FIRST
 * statement, before any Firestore read and before a client exists, and the
 * job env sets the switch to `off`. Zero platform calls by CALL ORDER, not by a
 * mock — and the outcome still PERSISTS, so the assertion is about a document
 * the dispatched function wrote, not about the absence of one.
 *
 * Since step 5 the dispatched bundle carries the order import in its seam, so
 * the switch is the ONLY thing between a task and a platform call: the run that
 * once parked as `importador-ausente` past the switch would now import. Case 1
 * is that boundary, observed from outside.
 *
 * Why the conta is seeded (case 1). The seed makes the reason discriminating:
 * were the switch checked AFTER the conta read, the same run would answer
 * `adiado/credencial-ausente` (an active conta with no credential), and were
 * the conta absent it would be dropped with no document at all. Only a refusal
 * at the switch writes `adiado/chamadas-desligadas`.
 *
 * What this proves that no `fakeDb` unit test can:
 *   - the reads queue is registered in the real artifact under the exact name
 *     the producer targets (a rename on one side only answers the enqueue with
 *     a 404);
 *   - the enqueue resolves the REGION-QUALIFIED queue path — the silent drop of
 *     #1108, the one failure mode that looks like success. `FUNCTIONS_REGION`
 *     (inlined into the bundle) and `LOJA_INTEGRADA_TASKS_REGION` (read by the
 *     producer at run time) must agree, and the workflow sets both;
 *   - the payload survives the hop (the handler found the order the test named);
 *   - the dispatched bundle carries the pipeline, the context and the switch,
 *     and `defer` survives the queue hop as a `deferred` row rather than a
 *     `failed` one;
 *   - a payload the schema refuses, and a `tipo` the queue does not serve, are
 *     DROPPED by the real function without taking the queue down (cases 2, 3).
 *
 * ⚠️ NOT covered, and deliberately not asserted:
 *   - `retryConfig` / `rateLimits`. Emulated at best, and cheaper to assert off
 *     `__endpoint` — `index.test.ts` does that. Whether the emulator honours
 *     `maxConcurrentDispatches` is unverified.
 *   - any `scheduleDelaySeconds`. This queue sets none, and the emulator ignores
 *     it anyway (firebase-tools#8254).
 *   - the importer, a context that passes the switch, or any platform call —
 *     those need the switch on, which this lane never turns on.
 *   - the `onSchedule` triggers: the functions emulator logs each as ignored
 *     because the pubsub emulator is not running.
 *
 * ⚠️ The ABSENCE assertions (cases 2 and 3) cannot be polled honestly: a drop
 * writes nothing, so the only evidence is a document that a LATER task wrote.
 * Each case therefore enqueues the sentinel AFTER the task under test, waits for
 * the sentinel's row, gives an in-flight dispatch a moment to land, and only
 * then reads the whole collection. The queue dispatches in creation order, so a
 * stray row for the earlier task would be there by then.
 */
import { getFunctions } from 'firebase-admin/functions';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  INTEGRACAO_TIPO,
  NOTIFICACAO_RESILIENCIA_STATUS,
  ORIGEM_NOTIFICACAO_LI,
  TIPO_TAREFA_LI,
} from '@delfrance/schemas';

import { getAdminApp, getAdminFirestore } from '@/lib/firebase/admin';

import {
  FILA_LEITURA_LI,
  type PayloadNotificacaoLi,
} from '../../lib/lojaIntegrada/notificacoes/notificacao';
import { criarAgendadorLiDoAmbiente, regiaoDaFilaLi } from './agendador';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const NOTIF = 'notificacoesLojaIntegrada';
const CONTAS = 'integracao';

/** An obviously fake conta id inside the grammar the task schema accepts. */
const CONTA_ID = 'conta-li-ci';

/** The canonical stamp of the order change, to the microsecond. */
const STAMP = '2026-10-13T08:15:58.123456';

/** `<conta>:<numero>:<origem>:<the stamp's digits>` — spelled out, not derived from the code under test. */
function idDoDocumento(numero: string): string {
  return `${CONTA_ID}:${numero}:poll:20261013081558123456`;
}

function payload(numero: string): PayloadNotificacaoLi {
  return {
    tipo: TIPO_TAREFA_LI.pedido,
    contaId: CONTA_ID,
    numero,
    origem: ORIGEM_NOTIFICACAO_LI.poll,
    dataModificacaoLi: STAMP,
  };
}

function db() {
  return getAdminFirestore();
}

/**
 * The queue itself, for the payloads the typed producer refuses to build. The
 * path comes from the producer root's own region guard, so a lane that forgot
 * `LOJA_INTEGRADA_TASKS_REGION` fails here exactly as the real producer would.
 */
function filaBruta() {
  return getFunctions(getAdminApp()).taskQueue<Record<string, unknown>>(
    `locations/${regiaoDaFilaLi()}/functions/${FILA_LEITURA_LI}`,
  );
}

function aguardar(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll for the document the DISPATCHED function writes.
 *
 * The task travels producer → tasks emulator → functions emulator → handler, so
 * there is no promise to await, only the effect. A fixed sleep would be both
 * flaky and wrong in the other direction: `emulators:exec` tears the suite down
 * the moment the script exits, so waiting on the effect is also what keeps an
 * in-flight dispatch from being killed.
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
          'Nada chegar significa que o Cloud Tasks aceitou a tarefa e nunca a ' +
          'entregou — o descarte silencioso de região do #1108. Confira que ' +
          'LOJA_INTEGRADA_TASKS_REGION é igual ao FUNCTIONS_REGION embutido no ' +
          'bundle (.github/workflows/ci-loja-integrada.yml define os dois com o mesmo ' +
          'valor) e que prepare-deploy.mjs rodou antes do emulators:exec. ' +
          '⚠️ Se o id ACIMA aparece na lista, o problema é outro: leia o `status` e o ' +
          '`erro` do documento.',
      );
    }
    await aguardar(250);
  }
}

/** Every document id in the collection, sorted. */
async function idsDaColecao(): Promise<string[]> {
  const todos = await db().collection(NOTIF).get();
  return todos.docs.map((d) => d.id).sort();
}

describe.skipIf(!EMULATED || !TASKS)(
  'fila de leitura da Loja Integrada → Cloud Tasks → onTaskDispatched',
  () => {
    beforeAll(() => {
      // Initialise the admin app FIRST, with the project pinned by the setup
      // file: the producer root's `getAdminApp()` reuses the default app, so it
      // never resolves a project on its own.
      db();
    });

    beforeEach(async () => {
      for (const colecao of [NOTIF, CONTAS]) {
        const refs = await db().collection(colecao).listDocuments();
        await Promise.all(refs.map((r) => r.delete()));
      }
      // An ACTIVE Loja Integrada conta with NO credential: the case-1 reason can
      // then only come from the switch (header).
      await db().collection(CONTAS).doc(CONTA_ID).set({
        tipo: INTEGRACAO_TIPO.lojaIntegrada,
        nome: 'Loja de teste',
        ativo: true,
      });
    });

    it('adia na chave de leitura desligada — a função despachada grava `deferred`, sem chamar a plataforma', async () => {
      await criarAgendadorLiDoAmbiente().enfileirar(payload('424201'));

      const doc = await aguardarDocumento(idDoDocumento('424201'));

      expect(doc).toMatchObject({
        tipo: TIPO_TAREFA_LI.pedido,
        contaId: CONTA_ID,
        numero: '424201',
        origem: ORIGEM_NOTIFICACAO_LI.poll,
        dataModificacaoLi: STAMP,
        // ⚠️ `deferred`, not `parked` and not `failed`. `failed` would mean the
        // run THREW (and the last attempt persisted it): the queue hop worked
        // but the dispatched bundle raised instead of refusing. `parked`, or
        // no row at all (a resolved import), would mean the run got PAST the
        // switch and into the order import, which calls the platform.
        status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
        tentativas: 0,
        // The reason names the switch. `adiado/credencial-ausente` here would
        // mean the context read the conta before checking the switch; no row at
        // all, that the conta was never found.
        erro: 'adiado/chamadas-desligadas',
      });
      // Stamped by the handler inside the emulator, not by this process.
      expect(doc.processedAt).toBeGreaterThan(0);
    });

    it('descarta um payload que o schema recusa e segue — nenhum documento para ele', async () => {
      // A leading zero fails the `numero` grammar: the pipeline drops the task
      // on its schema, before any context exists.
      await filaBruta().enqueue({ ...payload('424202'), numero: '0424202' });
      await criarAgendadorLiDoAmbiente().enfileirar(payload('424203'));

      await aguardarDocumento(idDoDocumento('424203'));
      await aguardar(2_000);

      // Only the sentinel: a row for the malformed task would be a drop that
      // persisted something nobody could ever process.
      expect(await idsDaColecao()).toEqual([idDoDocumento('424203')]);
    });

    it('descarta um `tipo` que a fila não atende e segue — nenhum documento para ele', async () => {
      // Valid in every field but `tipo`: the dispatch drops it by its own
      // `tipo` table rather than spending retries or parking a row.
      await filaBruta().enqueue({ ...payload('424204'), tipo: 'conciliacao' });
      await criarAgendadorLiDoAmbiente().enfileirar(payload('424205'));

      await aguardarDocumento(idDoDocumento('424205'));
      await aguardar(2_000);

      expect(await idsDaColecao()).toEqual([idDoDocumento('424205')]);
    });
  },
);
