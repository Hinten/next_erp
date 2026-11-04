/**
 * The status write-back's round trip, end to end, against the real emulators
 * (`ci-loja-integrada.yml`; master plan step 7, PR 7-e).
 *
 * What runs for real here, with nothing mocked:
 *
 *   a freight history row CREATED under an imported Loja Integrada pedido
 *     → onHistoricoFreteLojaIntegrada            the real deployed Firestore trigger
 *     → the valve (`dry-run`, the job env) → ONE pedido read → the identity proof
 *     → the real producer root → a NAMED task on the region-qualified queue
 *     → Cloud Tasks emulator → Functions emulator
 *     → filaEscritaLojaIntegrada                  the real deployed onTaskDispatched
 *     → the writes pipeline → the run: valve, pedido, freshness, target decision
 *     → the write context refuses on the READ SWITCH (`off`, the job env)
 *     → `adiado/chamadas-desligadas` → `defer`
 *     → a real `deferred` doc in notificacoesEscritaLojaIntegrada
 *
 * and, for the backstop:
 *
 *   a `varredura` task enqueued through the real producer root (the scheduler's
 *   own call — `onSchedule` is ignored by the emulator)
 *     → filaEscritaLojaIntegrada → the in-queue sweep, both lanes
 *     → a seeded `failed` row re-run → stopped at the read switch
 *     → the row MIGRATES to `deferred` with a fresh budget
 *
 * ⚠️ Why the switch refusal, and not a happier path. The lane's non-localhost
 * `fetch` kill-switch lives in the VITEST process and does not cover the
 * dispatched function, which runs in the emulator's own process. The write
 * context checks `LOJA_INTEGRADA_CHAMADAS` as its FIRST statement, before any
 * Firestore read of the conta and before a client exists, so the run makes zero
 * platform calls by CALL ORDER — and writes NOTHING to Loja Integrada — while
 * its outcome still PERSISTS: every assertion is about a document the
 * dispatched function wrote. The valve at `dry-run` (also the job env) is what
 * lets the trigger enqueue at all; `vitest.tasks.setup.ts` refuses a valve
 * exactly `on` and any canary list.
 *
 * Why the conta is seeded: active, with NO credential. Were the switch checked
 * after the conta read, the same run would answer `adiado/credencial-ausente`.
 * It carries no filial and no `dataCadastro`, so the conta trigger
 * (`onIntegracaoLojaIntegradaChanged`), which fires on it too, only reads; its
 * id is this suite's own.
 *
 * What this proves that no offline test can:
 *   - the trigger is registered in the real artifact on the real path, and the
 *     emulator delivers a CREATE of a history row to it;
 *   - the writes queue is registered under the exact name the producer targets,
 *     at the REGION-QUALIFIED path (the silent drop of #1108), and accepts a
 *     NAMED task;
 *   - the payload the trigger builds survives the hop (the row carries it);
 *   - the varredura runs inside the dispatched writes function.
 *
 * ⚠️ NOT covered, and deliberately not asserted:
 *   - named-task dedup: unproven in the emulator, so a second enqueue's answer
 *     is not asserted (the producer's unit tests pin the rule);
 *   - the trigger's filter (a non-target estado, a non-LI pedido, the valve
 *     off): an absence proves nothing here — an enqueued non-LI payload would
 *     also end as a drop with no row, and the emulator does not order triggers
 *     by write order. `onHistoricoFreteLojaIntegrada.test.ts` pins it offline by
 *     counting reads and enqueues;
 *   - `rateLimits`, the instance limits and the retry ladder (`index.test.ts`);
 *   - the `onSchedule` timer itself (ignored without the pubsub emulator).
 */
import { createHash } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ESTADO_FRETE,
  INTEGRACAO_TIPO,
  NOTIFICACAO_RESILIENCIA_STATUS,
  TIPO_TAREFA_ESCRITA_LI,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { TIPO_TAREFA_VARREDURA_ESCRITA_LI } from '../../lib/lojaIntegrada/rastreio/agendadorEscrita';
import { criarAgendadorEscritaLiDoAmbiente } from './agendadorEscrita';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const NOTIF = 'notificacoesEscritaLojaIntegrada';
/** This suite's own conta: no other suite seeds it (`vitest.tasks.config.ts`). */
const CONTA_ID = 'conta-li-escrita-ci';
const NUMERO_TRIGGER = '434301';
const NUMERO_VARREDURA = '434302';
const DATA_MS = Date.UTC(2026, 9, 26, 12, 0, 0);

/** sha256 hex — spelled out here, never imported from the code under test. */
function sha256(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

/** The imported pedido's id: the digest of `lojaIntegrada<conta>-<numero>`. */
function idDoPedido(numero: string): string {
  return sha256(`lojaIntegrada${CONTA_ID}-${numero}`);
}

/** The write event's id: the digest of `historico:<pedidoId>/<historicoId>`. */
function idDoEvento(pedidoId: string, historicoId: string): string {
  return sha256(`historico:${pedidoId}/${historicoId}`);
}

function db() {
  return getAdminFirestore();
}

function aguardar(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll for the document the DISPATCHED function writes, until `pronto` holds.
 * The event travels trigger → tasks emulator → functions emulator → handler, so
 * there is no promise to await, only the effect.
 */
async function aguardarDocumento(
  docId: string,
  pronto: (d: FirebaseFirestore.DocumentData) => boolean,
  timeoutMs = 45_000,
): Promise<FirebaseFirestore.DocumentData> {
  const prazo = Date.now() + timeoutMs;
  for (;;) {
    const snap = await db().collection(NOTIF).doc(docId).get();
    const dados = snap.exists ? (snap.data() ?? {}) : null;
    if (dados !== null && pronto(dados)) return dados;
    if (Date.now() > prazo) {
      const todos = await db().collection(NOTIF).get();
      throw new Error(
        `a escrita ${docId} não chegou ao estado esperado em ${String(timeoutMs)}ms ` +
          `(atual: ${dados === null ? '<ausente>' : JSON.stringify({ status: dados.status, erro: dados.erro })}). ` +
          `A coleção tem ${String(todos.size)} doc(s): ${todos.docs.map((d) => d.id).join(', ') || '<vazia>'}. ` +
          'Sem documento algum: confira que LOJA_INTEGRADA_MODO_RASTREIO=dry-run está no ' +
          'ambiente do emulators:exec (com a válvula off o gatilho não enfileira nada), que ' +
          'LOJA_INTEGRADA_TASKS_REGION é igual ao FUNCTIONS_REGION embutido no bundle ' +
          '(o descarte silencioso do #1108) e que prepare-deploy.mjs rodou antes do ' +
          'emulators:exec (.github/workflows/ci-loja-integrada.yml).',
      );
    }
    await aguardar(250);
  }
}

/** Seed one imported Loja Integrada pedido of this suite's conta, posted. */
async function seedPedido(numero: string): Promise<string> {
  const id = idDoPedido(numero);
  await db()
    .collection('pedidos')
    .doc(id)
    .set({
      numero,
      integracaoPedidoOuterRef: `integracao/${CONTA_ID}`,
      freteInicial: {
        estado: ESTADO_FRETE.postado,
        codRastreio: 'PJ000000000BR',
        externalId: '801',
      },
    });
  return id;
}

describe.skipIf(!EMULATED || !TASKS)(
  'fila de escritas da Loja Integrada → gatilho do histórico de frete → Cloud Tasks → onTaskDispatched',
  () => {
    beforeAll(() => {
      // Initialise the admin app FIRST, with the project pinned by the setup
      // file: the producer root's `getAdminApp()` reuses the default app.
      db();
    });

    beforeEach(async () => {
      const refs = await db().collection(NOTIF).listDocuments();
      await Promise.all(refs.map((r) => r.delete()));
      for (const numero of [NUMERO_TRIGGER, NUMERO_VARREDURA]) {
        await db().recursiveDelete(db().collection('pedidos').doc(idDoPedido(numero)));
      }
      // ACTIVE, with NO credential: the reason can then only come from the
      // switch (header). Incomplete for the conta trigger, which only reads.
      await db().collection('integracao').doc(CONTA_ID).set({
        tipo: INTEGRACAO_TIPO.lojaIntegrada,
        nome: 'Loja de teste (escritas)',
        ativo: true,
      });
    });

    it('um histórico `postado` de um pedido da Loja Integrada vira UMA tarefa nomeada, e a função despachada adia na chave de leitura — nada escrito na Loja Integrada', async () => {
      // The lane's own precondition, from the same shell the emulator got.
      expect(
        process.env.LOJA_INTEGRADA_MODO_RASTREIO,
        'ci-loja-integrada.yml define LOJA_INTEGRADA_MODO_RASTREIO=dry-run para esta suíte',
      ).toBe('dry-run');
      const pedidoId = await seedPedido(NUMERO_TRIGGER);
      const historicoId = 'evento-historico-ci-1';

      await db()
        .collection('pedidos')
        .doc(pedidoId)
        .collection('historicoFtIni')
        .doc(historicoId)
        .set({
          estado: ESTADO_FRETE.postado,
          obs: null,
          usuarioHistoricoFreteInicialOuterRef: null,
          data: DATA_MS,
          eventId: historicoId,
        });

      const evento = idDoEvento(pedidoId, historicoId);
      const doc = await aguardarDocumento(
        evento,
        (d) => d.status === NOTIFICACAO_RESILIENCIA_STATUS.deferred,
      );

      expect(doc).toMatchObject({
        // The payload the TRIGGER built, carried through the hop.
        tipo: TIPO_TAREFA_ESCRITA_LI.rastreio,
        contaId: CONTA_ID,
        numero: NUMERO_TRIGGER,
        pedidoId,
        evento,
        estado: ESTADO_FRETE.postado,
        eventoEmMs: DATA_MS,
        // ⚠️ `deferred`, not `failed` (the run threw) nor `parked`. The reason
        // names the switch: `adiado/credencial-ausente` would mean the context
        // read the conta first; `adiado/dry-run…` that it never refused.
        status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
        tentativas: 0,
        erro: 'adiado/chamadas-desligadas',
      });
      // Stamped by the handler inside the emulator, not by this process.
      expect(doc.processedAt).toBeGreaterThan(0);
    });

    it('uma tarefa `varredura` roda AS DUAS RAIAS dentro da fila de escritas: uma linha `failed` antiga migra para `deferred` com orçamento novo', async () => {
      const pedidoId = await seedPedido(NUMERO_VARREDURA);
      const evento = idDoEvento(pedidoId, 'evento-historico-ci-2');
      // A failed row, older than the hot lane's one-hour window.
      await db().collection(NOTIF).doc(evento).set({
        tipo: TIPO_TAREFA_ESCRITA_LI.rastreio,
        contaId: CONTA_ID,
        numero: NUMERO_VARREDURA,
        pedidoId,
        evento,
        estado: ESTADO_FRETE.postado,
        eventoEmMs: DATA_MS,
        status: NOTIFICACAO_RESILIENCIA_STATUS.failed,
        tentativas: 2,
        erro: 'enfileiramento-desligado',
        processedAt: 1,
      });

      await criarAgendadorEscritaLiDoAmbiente().enfileirar(
        { tipo: TIPO_TAREFA_VARREDURA_ESCRITA_LI },
        { id: `varredura-ci-${String(Date.now())}` },
      );

      const doc = await aguardarDocumento(
        evento,
        (d) => d.status === NOTIFICACAO_RESILIENCIA_STATUS.deferred,
      );
      expect(doc).toMatchObject({
        evento,
        status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
        // The hot lane hands a deferred outcome to the deferred lane with a
        // FRESH budget: proof the shared core's sweep ran, not a direct write.
        tentativas: 0,
        erro: 'adiado/chamadas-desligadas',
      });
      expect(doc.processedAt).toBeGreaterThan(1);
    });
  },
);
