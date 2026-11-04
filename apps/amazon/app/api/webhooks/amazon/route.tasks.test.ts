/**
 * The push receiver's Cloud Tasks hop, end to end, against the real emulators
 * (`ci-amazon.yml`; step-3 plan PR 3-e, suite 1).
 *
 * What runs for real here, with nothing mocked:
 *
 *   POST /api/webhooks/amazon                   the real route + the relay key
 *     → receberNotificacaoAmazon                the real receiver
 *     → agendadorDaFilaLeituraAmazon()          the real App Hosting producer root
 *     → the real region-qualified queue path
 *     → Cloud Tasks emulator → Functions emulator
 *     → filaLeituraAmazon                       the real deployed onTaskDispatched
 *     → tratarTarefaLeituraAmazon → the notification pipeline
 *     → the READ SWITCH refuses, before any Firestore read
 *     → `adiado/chamadas-desligadas` → `defer`
 *     → a real `deferred` doc in notificacoesAmazon, id `push:<NotificationId>`
 *
 * ⚠️ Why the switch refusal, and not a happier path (D11, step-3 plan §3
 * decision 37). The lane's non-localhost `fetch` kill-switch lives in the
 * VITEST process and does NOT cover the dispatched function, which runs in the
 * emulator's own process. The pipeline checks `AMAZON_CHAMADAS` as its FIRST
 * statement, and the job env sets it to `off`: zero Amazon calls by CALL ORDER,
 * not by a mock — and the outcome still PERSISTS, so the assertion is about a
 * document the dispatched function wrote. `importado ⇒ resolve` is proved in
 * the vitest process instead (`notificacao.firestore.test.ts`).
 *
 * Why NO conta is seeded. That is what makes the reason discriminating: were
 * the switch checked after the routing read, this seller (bound to no conta)
 * would defer as `adiado/sem-conta`. Only a refusal at the switch writes
 * `adiado/chamadas-desligadas`.
 *
 * What this proves that no fake-db unit test can:
 *   - the receiver's answer for a delivery the relay would send (the `{ body }`
 *     wrapper, the relay key) is 200 with the real configuration the lane sets;
 *   - the reads queue is registered in the real artifact under the exact name
 *     the producer targets, and the enqueue resolves the REGION-QUALIFIED path
 *     (#1108). `FUNCTIONS_REGION` (inlined into the bundle) and
 *     `AMAZON_TASKS_REGION` (read by the producer) must agree; the workflow sets
 *     both. In the emulator a mismatch is REFUSED rather than dropped, so it
 *     shows as a `failed` row the receiver persisted — the status assertion
 *     below names it;
 *   - the ids-only payload survives the hop and the dispatched `taskSchema`
 *     (a mismatch is a silent DROP, no row), and lands with exactly its fields;
 *   - a foreign application id is dropped before the queue, a duplicated
 *     `NotificationId` collapses onto ONE row, and the sweep-only valve makes
 *     the receiver persist the delivery itself.
 *
 * ⚠️ NOT covered, and deliberately not asserted:
 *   - the relay (SQS → EventBridge Pipe → API destination): the suite POSTs the
 *     relay's `{ body }` wrapper itself;
 *   - `retryConfig` / `rateLimits` — pinned off `__endpoint` in
 *     `functions/src/index.test.ts`; any `scheduleDelaySeconds` (none is set,
 *     and the emulator ignores it, firebase-tools#8254);
 *   - the importer, a context past the switch, or any Amazon call.
 *
 * ⚠️ ABSENCE assertions (cases b and c) cannot be polled honestly: a drop
 * writes nothing, so the only evidence is a document a LATER delivery wrote.
 * Each case POSTs a sentinel AFTER the deliveries under test, waits for the
 * sentinel's row, gives an in-flight dispatch a moment to land, and only then
 * reads the whole collection. The queue dispatches in creation order, so a
 * stray row for an earlier delivery would be there by then.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CABECALHO_CHAVE_RELAY_AMAZON,
  CAMINHO_RECEPTOR_AMAZON,
  CAMPO_CORPO_RELAY_AMAZON,
  NOTIFICACAO_RESILIENCIA_STATUS,
  ORIGEM_NOTIFICACAO_AMAZON,
  TIPO_TAREFA_AMAZON,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { agendadorDaFilaLeituraAmazon } from '@/lib/firebase/filaLeitura';
import { DIRETORIO_WIRE_AMAZON } from '@/lib/amazon/fixtures/wireCorpus';
import { SPID_A } from '@/lib/amazon/testing/fixtures';

import { POST } from './route';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const NOTIF = 'notificacoesAmazon';

/** The lane's relay key and application id (`ci-amazon.yml` sets both); `''` when unset. */
const CHAVE_RELAY = process.env.AMAZON_RELAY_SECRET ?? '';
const APLICACAO = process.env.AMAZON_APPLICATION_ID ?? '';
/** The sweep-only valve as the lane set it (unset), restored after case (d). */
const VALVULA_ORIGINAL = process.env.AMAZON_TASKS_DISABLED;
/** Another application's id: same grammar, never ours. */
const APLICACAO_ESTRANGEIRA = 'amzn1.sp.solution.11111111-1111-1111-1111-111111111111';

/** The `PublishTime` every delivery here carries, and its ms (the stored `publishTimeMs`). */
const PUBLISH_TIME = '2026-10-20T12:00:00.000Z';
const PUBLISH_MS = Date.UTC(2026, 9, 20, 12, 0, 0, 0);

/** The committed model example's SQS body (`sb-order-change.json`, sanitized). */
const MODELO = (
  JSON.parse(readFileSync(join(DIRETORIO_WIRE_AMAZON, 'sb-order-change.json'), 'utf8')) as {
    resposta: { corpo: Record<string, unknown> };
  }
).resposta.corpo;

const PEDIDO = String(
  ((MODELO.Payload as Record<string, unknown>).OrderChangeNotification as Record<string, unknown>)
    .AmazonOrderId,
);

/** A fresh NotificationId per delivery: a UUID, inside the visible-ASCII grammar. */
function novaNotificacao(): string {
  return `ci-${randomUUID()}`;
}

/**
 * One ORDER_CHANGE SQS body: the model example with the routing fields set —
 * the sanitizer redacted the application and seller ids, so the test puts the
 * lane's and a placeholder back.
 */
function corpoOrderChange(
  notificationId: string,
  aplicacao: string = APLICACAO,
): Record<string, unknown> {
  const corpo = structuredClone(MODELO);
  const meta = corpo.NotificationMetadata as Record<string, unknown>;
  meta.ApplicationId = aplicacao;
  meta.NotificationId = notificationId;
  meta.PublishTime = PUBLISH_TIME;
  (
    (corpo.Payload as Record<string, unknown>).OrderChangeNotification as Record<string, unknown>
  ).SellerId = SPID_A;
  return corpo;
}

/** POST one delivery as the relay's API destination does: the `{ body }` wrapper, the key header. */
function entregar(corpo: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request(`http://localhost:3011${CAMINHO_RECEPTOR_AMAZON}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CABECALHO_CHAVE_RELAY_AMAZON]: CHAVE_RELAY },
      body: JSON.stringify({ [CAMPO_CORPO_RELAY_AMAZON]: corpo }),
    }),
  );
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
 * The message a missing row gets: the causes that CAN produce it in the emulator.
 *
 * ⚠️ Not a region mismatch (#1108): the tasks emulator REFUSES an unknown queue
 * instead of dropping it, so a mismatch shows as a 404 at the enqueue — a
 * `failed` row the receiver persisted with an `enfileiramento/…` reason, or the
 * warm-up throwing — never as this timeout. What does time out here: the queue
 * is serial (`maxConcurrentDispatches: 1`), so an EARLIER task that keeps
 * failing is retried at its head and starves every later delivery.
 */
async function semDocumento(rotulo: string, timeoutMs: number): Promise<Error> {
  const todos = await db().collection(NOTIF).get();
  return new Error(
    `${rotulo} não chegou em ${String(timeoutMs)}ms. ` +
      `A coleção tem ${String(todos.size)} doc(s): ${todos.docs.map((d) => d.id).join(', ') || '<vazia>'}. ` +
      'Causas possíveis no emulador: (i) uma tarefa ANTERIOR falha e é retentada — a ' +
      'fila é serial, então ela trava as seguintes; procure `Unhandled error` no log ' +
      'do emulador de functions; (ii) a função despachada não gravou nada ' +
      '(`payload-invalido` no taskSchema — a linha `[amazon] tarefa da fila de ' +
      'leitura` do emulador diz); (iii) o emulador de functions não carregou o ' +
      'artefato (prepare-deploy.mjs rodou antes do emulators:exec?). ⚠️ Uma ' +
      'divergência de região NÃO aparece aqui: o emulador de tarefas recusa a fila ' +
      'desconhecida (404 no enfileiramento), então ela vira uma linha `failed` com ' +
      'motivo `enfileiramento/…` gravada pelo receptor, ou o aquecimento lança. Se o ' +
      'id esperado aparece na lista, leia o `status` e o `erro` do documento.',
  );
}

/**
 * Poll for the document the DISPATCHED function writes, by its id.
 *
 * The task travels receiver → tasks emulator → functions emulator → handler, so
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
    if (Date.now() > prazo) throw await semDocumento(`a notificação ${docId}`, timeoutMs);
    await aguardar(250);
  }
}

/**
 * The same, by the stored `notificationId` FIELD rather than the document id —
 * so the duplicate case still finds its rows when a mutation makes the store
 * mint auto ids (`docIdOf` → null), and fails on the COUNT rather than on a
 * timeout.
 */
async function aguardarPorNotificacao(
  notificationId: string,
  timeoutMs = 45_000,
): Promise<string[]> {
  const prazo = Date.now() + timeoutMs;
  for (;;) {
    const ids = await idsPorNotificacao(notificationId);
    if (ids.length > 0) return ids;
    if (Date.now() > prazo) throw await semDocumento(`a notificação ${notificationId}`, timeoutMs);
    await aguardar(250);
  }
}

async function idsPorNotificacao(notificationId: string): Promise<string[]> {
  const snap = await db().collection(NOTIF).where('notificationId', '==', notificationId).get();
  return snap.docs.map((d) => d.id).sort();
}

/** Every document id in the collection, sorted. */
async function idsDaColecao(): Promise<string[]> {
  const todos = await db().collection(NOTIF).get();
  return todos.docs.map((d) => d.id).sort();
}

async function limparColecao(): Promise<void> {
  const refs = await db().collection(NOTIF).listDocuments();
  await Promise.all(refs.map((r) => r.delete()));
}

describe.skipIf(!EMULATED || !TASKS)('webhook Amazon → Cloud Tasks → onTaskDispatched', () => {
  beforeAll(async () => {
    // Initialise the admin app FIRST, with the project pinned by the setup
    // file: the producer root's `getAdminApp()` reuses the default app.
    db();
    await limparColecao();
    // ⚠️ WARM-UP, not a test. The receiver races its enqueue against a 2-s
    // deadline (`PRAZO_ENFILEIRAMENTO_RECEPTOR_MS`, step-3 plan §3 decision 32),
    // and the Admin SDK's FIRST enqueue in a process resolves a service account
    // through Application Default Credentials before falling back to the
    // emulated one — on a runner outside GCP that probe can outlast 2 s, and
    // the functions emulator's first dispatch is a cold start too. A cold first
    // delivery would then be persisted `failed` by the receiver's own fallback
    // (correct production behaviour) instead of reaching the queue, and case
    // (a) would be testing the deadline rather than the hop. So one enqueue
    // through the SAME producer root goes first, unraced, and its row is
    // awaited (the hop works) and wiped before the cases run.
    const aquecimento = novaNotificacao();
    await agendadorDaFilaLeituraAmazon().enfileirar({
      tipo: TIPO_TAREFA_AMAZON.pedido,
      origem: ORIGEM_NOTIFICACAO_AMAZON.push,
      sellerId: SPID_A,
      amazonOrderId: PEDIDO,
      notificationId: aquecimento,
      publishTimeMs: PUBLISH_MS,
    });
    // By the FIELD, not the id: a broken `docIdOf` must fail case (c) on its
    // count, not this warm-up on a timeout.
    await aguardarPorNotificacao(aquecimento);
  }, 120_000); // the cold start above: an SDK probe plus the emulator's first dispatch

  beforeEach(async () => {
    await limparColecao();
  });

  afterEach(() => {
    // Case (d) closes the valve in THIS process; nothing else may see it closed.
    if (VALVULA_ORIGINAL === undefined) delete process.env.AMAZON_TASKS_DISABLED;
    else process.env.AMAZON_TASKS_DISABLED = VALVULA_ORIGINAL;
  });

  // A real queue hop: the enqueue, the emulator's dispatch and the poll (~1-7 s locally).
  it(
    '(a) enfileira na fila real e a função despachada para na chave: grava `deferred`, sem chamar a Amazon',
    { timeout: 60_000 },
    async () => {
      const id = novaNotificacao();
      const res = await entregar(corpoOrderChange(id));

      // ⚠️ ASSERTED BEFORE ANY POLLING, and that order is the point. A 503 (no
      // relay secret or application id in the lane env) or a 401 (the wrong key)
      // enqueues NOTHING, so the poll below would spend 45 seconds and then send
      // the reader to the queue — the wrong place. The answer carries an EMPTY
      // body.
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');

      const doc = await aguardarDocumento(`push:${id}`);

      expect(doc).toMatchObject({
        tipo: TIPO_TAREFA_AMAZON.pedido,
        origem: ORIGEM_NOTIFICACAO_AMAZON.push,
        sellerId: SPID_A,
        amazonOrderId: PEDIDO,
        notificationId: id,
        // `PublishTime` crossed the hop as ms, not re-derived by the handler.
        publishTimeMs: PUBLISH_MS,
        // ⚠️ `deferred`, not `failed` and not `parked`. `failed` with an
        // `enfileiramento/…` reason is the RECEIVER's own fallback: the enqueue
        // threw or missed its 2-s deadline (a region mismatch is refused by the
        // tasks emulator, so it lands HERE, in seconds, instead of timing out).
        // `parked` would mean the dispatched bundle reached a refusal past the
        // switch.
        status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
        tentativas: 0,
        // The dispatched function stopped at ITS read switch (D11's second layer).
        // `adiado/sem-conta` here would mean the pipeline routed (read Firestore)
        // before checking the switch.
        erro: 'adiado/chamadas-desligadas',
      });
      // Stamped by the handler inside the emulator, not by this process.
      expect(doc.processedAt).toBeGreaterThan(0);
      // IDS ONLY across the hop (step-3 plan §3 decision 29): the push body's
      // other fields — buyer data among them — never reach the row. The row holds
      // both variants' ids (the document schema is one plain object), the poll
      // ones `null`.
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
      expect(doc).toMatchObject({ contaId: null, lastUpdatedUs: null });
    },
  );

  // A real queue hop: the enqueue, the emulator's dispatch and the poll (~1-7 s locally).
  it(
    '(b) descarta uma aplicação estrangeira com 200 — nenhum documento, provado por uma sentinela',
    { timeout: 60_000 },
    async () => {
      const estrangeira = novaNotificacao();
      const sentinela = novaNotificacao();

      const r1 = await entregar(corpoOrderChange(estrangeira, APLICACAO_ESTRANGEIRA));
      // 200, never a 4xx: the API destination might auto-disable the pipe on one.
      expect(r1.status).toBe(200);
      const r2 = await entregar(corpoOrderChange(sentinela));
      expect(r2.status).toBe(200);

      // The POSITIVE assertion first: the sentinel, POSTed AFTER the foreign
      // delivery, landed — so a task for the foreign one, dispatched in creation
      // order, would have landed too.
      await aguardarDocumento(`push:${sentinela}`);
      await aguardar(2_000);

      expect(await idsDaColecao()).toEqual([`push:${sentinela}`]);
    },
  );

  // A real queue hop: the enqueue, the emulator's dispatch and the poll (~1-7 s locally).
  it(
    '(c) o mesmo NotificationId duas vezes: dois 200, UMA linha — a segunda tarefa colide no id determinístico',
    { timeout: 60_000 },
    async () => {
      const duplicada = novaNotificacao();
      const sentinela = novaNotificacao();

      // The receiver does not dedup (that is the store's and the importer's job):
      // each delivery is enqueued, so two tasks carry the same payload.
      const r1 = await entregar(corpoOrderChange(duplicada));
      const r2 = await entregar(corpoOrderChange(duplicada));
      expect([r1.status, r2.status]).toEqual([200, 200]);
      // ⚠️ The sentinel is what makes "exactly one" mean something: without it,
      // the count below could be read before the SECOND dispatch ran, and pass
      // for the wrong reason. Both duplicate tasks were created before it, and
      // the queue dispatches in creation order.
      const r3 = await entregar(corpoOrderChange(sentinela));
      expect(r3.status).toBe(200);

      await aguardarPorNotificacao(sentinela);
      await aguardar(2_000);

      // The second dispatch wrote nothing observable: the core's `create` on the
      // deterministic `push:<NotificationId>` hit ALREADY_EXISTS and ignored it.
      // Were the id not deterministic, there would be TWO rows here.
      expect(await idsPorNotificacao(duplicada)).toEqual([`push:${duplicada}`]);
      expect(await idsDaColecao()).toEqual([`push:${duplicada}`, `push:${sentinela}`].sort());
    },
  );

  it('(d) com AMAZON_TASKS_DISABLED=1 o próprio receptor persiste `failed` antes do 200', async () => {
    const id = novaNotificacao();
    // The sweep-only valve, read by the producer root per POST.
    process.env.AMAZON_TASKS_DISABLED = '1';
    const res = await entregar(corpoOrderChange(id));
    expect(res.status).toBe(200);

    // Read ONCE, with no polling: the receiver persisted before it answered.
    const snap = await db().collection(NOTIF).doc(`push:${id}`).get();
    expect(snap.exists).toBe(true);
    expect(snap.data()).toMatchObject({
      origem: ORIGEM_NOTIFICACAO_AMAZON.push,
      notificationId: id,
      // `failed`, the HOT lane: the reprocess sweep drains it. A `deferred`
      // here would mean the valve did not close and a dispatched task wrote it.
      status: NOTIFICACAO_RESILIENCIA_STATUS.failed,
      tentativas: 0,
      erro: 'enfileiramento/AmazonTarefasDesligadasError',
    });
  });
});
