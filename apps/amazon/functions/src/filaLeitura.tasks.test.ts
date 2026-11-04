/**
 * The backstop poll's payload variant through the real reads queue
 * (`ci-amazon.yml`; step-3 plan PR 3-e, suite 2) — BEFORE step 4 exists.
 *
 * What runs for real here, with nothing mocked:
 *
 *   criarAgendadorAmazonDoAmbiente().enfileirar(payload)   the functions codebase's
 *                                                         own producer root (4-b's poll)
 *     → the real region-qualified queue path
 *     → Cloud Tasks emulator → Functions emulator
 *     → filaLeituraAmazon                                 the real deployed onTaskDispatched
 *     → tratarTarefaLeituraAmazon → the dispatched `taskSchema`
 *     → the READ SWITCH refuses → `adiado/chamadas-desligadas` → `defer`
 *     → a real `deferred` doc `poll:<conta>:<order>:<µs>`
 *
 * ⚠️ Why this exists now. The shared core's `handleTask` DROPS a payload that
 * fails `taskSchema` — no row, no retry — so a producer/schema mismatch is a
 * silent TOTAL loss. Step 4's producer will build exactly this `origem: 'poll'`
 * variant; proving it survives the real dispatched schema here means the
 * day 4-a lands, its payload is already known to arrive (the step-3 plan's
 * "silent-drop pitfall").
 *
 * Why the switch, and why no conta is seeded: the same D11 reasons as
 * `app/api/webhooks/amazon/route.tasks.test.ts` — the dispatched function
 * stops at `AMAZON_CHAMADAS`, its first statement, and the job env has it off.
 * A poll payload names its conta directly (no routing read), so were NO
 * switch checked before the conta read — neither the pipeline's nor the
 * context loader's own, which also comes first — this unseeded conta would
 * DROP as `conta-inexistente` and write nothing.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  NOTIFICACAO_RESILIENCIA_STATUS,
  ORIGEM_NOTIFICACAO_AMAZON,
  TIPO_TAREFA_AMAZON,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { SPID_A } from '@/lib/amazon/testing/fixtures';

import type { PayloadNotificacaoAmazon } from '../../lib/amazon/notificacoes/notificacao';
import { criarAgendadorAmazonDoAmbiente } from './agendador';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const NOTIF = 'notificacoesAmazon';

/** An obviously fake conta id inside the grammar the task schema accepts. */
const CONTA_ID = 'conta-amazon-ci';
/** An invented 3-7-7 order id. */
const PEDIDO = '900-0000000-0000001';
/** The order's `lastUpdatedTime`, in µs: 2026-10-13T08:15:58.123456Z. */
const ATUALIZADO_US = Date.UTC(2026, 9, 13, 8, 15, 58) * 1000 + 123_456;

/** `poll:<conta>:<order>:<µs>` — spelled out, not derived from the code under test. */
const ID_DO_DOCUMENTO = 'poll:conta-amazon-ci:900-0000000-0000001:1791879358123456';

function db() {
  return getAdminFirestore();
}

/**
 * Poll for the document the DISPATCHED function writes. There is no promise to
 * await, only the effect — and waiting on it is also what keeps
 * `emulators:exec` from tearing the suite down under an in-flight dispatch.
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
          'Causas possíveis no emulador: (i) a função despachada DESCARTOU o payload ' +
          'sem gravar — `payload-invalido` (a variante `poll` divergiu do taskSchema) ' +
          'ou `conta-inexistente` (a conta foi lida antes da chave); a linha ' +
          '`[amazon] tarefa da fila de leitura` do emulador diz qual; (ii) uma tarefa ' +
          'ANTERIOR falha e é retentada — a fila é serial, então ela trava esta; ' +
          'procure `Unhandled error` no log do emulador de functions; (iii) o emulador ' +
          'de functions não carregou o artefato (prepare-deploy.mjs rodou antes do ' +
          'emulators:exec?). ⚠️ Uma divergência de região NÃO aparece aqui: o emulador ' +
          'de tarefas recusa a fila desconhecida (404), então o `enfileirar` acima lança.',
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(!EMULATED || !TASKS)(
  'fila de leitura da Amazon ← a variante `poll` (passo 4) → onTaskDispatched',
  () => {
    beforeAll(() => {
      // Initialise the admin app FIRST, with the project pinned by the setup
      // file: the producer root's `getAdminApp()` reuses the default app.
      db();
    });

    beforeEach(async () => {
      const refs = await db().collection(NOTIF).listDocuments();
      await Promise.all(refs.map((r) => r.delete()));
    });

    // A real queue hop: the enqueue, the emulator's dispatch and the poll (~1 s locally).
    it(
      'chega intacta pelo taskSchema real e adia na chave — `deferred` com o id `poll:` determinístico',
      { timeout: 60_000 },
      async () => {
        const payload: PayloadNotificacaoAmazon = {
          tipo: TIPO_TAREFA_AMAZON.pedido,
          origem: ORIGEM_NOTIFICACAO_AMAZON.poll,
          sellerId: SPID_A,
          amazonOrderId: PEDIDO,
          contaId: CONTA_ID,
          lastUpdatedUs: ATUALIZADO_US,
        };
        await criarAgendadorAmazonDoAmbiente().enfileirar(payload);

        const doc = await aguardarDocumento(ID_DO_DOCUMENTO);

        expect(doc).toMatchObject({
          tipo: TIPO_TAREFA_AMAZON.pedido,
          origem: ORIGEM_NOTIFICACAO_AMAZON.poll,
          sellerId: SPID_A,
          amazonOrderId: PEDIDO,
          contaId: CONTA_ID,
          // The µs stamp crossed the JSON hop exactly (it is below 2^53).
          lastUpdatedUs: ATUALIZADO_US,
          // ⚠️ `deferred`: the dispatched function PARSED the poll variant and
          // stopped at its read switch. A schema mismatch writes no row at all
          // (the poll above times out naming `payload-invalido`), and
          // `conta-inexistente` (no switch before the conta read) writes none either.
          status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
          tentativas: 0,
          erro: 'adiado/chamadas-desligadas',
        });
        expect(doc.processedAt).toBeGreaterThan(0);
        // Ids only: the document schema's twelve fields (one plain object for
        // both variants), the push variant's two `null`.
        expect(Object.keys(doc).sort()).toEqual(
          [
            'amazonOrderId',
            'contaId',
            'erro',
            'lastUpdatedUs',
            'notificationId',
            'origem',
            'processedAt',
            'publishTimeMs',
            'sellerId',
            'status',
            'tentativas',
            'tipo',
          ].sort(),
        );
        expect(doc).toMatchObject({ notificationId: null, publishTimeMs: null });
      },
    );
  },
);
