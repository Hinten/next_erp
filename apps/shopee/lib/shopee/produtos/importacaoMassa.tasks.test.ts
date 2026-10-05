/**
 * The mass-import Cloud Tasks hop, end to end, against the real emulators
 * (`ci-shopee.yml`) — the SECOND `onTaskDispatched` of this codebase.
 *
 * What runs for real here, with nothing mocked:
 *
 *   createShopeeMassImportScheduler().enqueue({ jobId, integracaoId })
 *     → the real region-qualified queue name
 *     → Cloud Tasks emulator → Functions emulator
 *     → processShopeeMassImport          the real deployed onTaskDispatched
 *     → processarImportacaoShopee
 *     → resolverContexto → loadShopeeContext
 *     → a conta of the WRONG `tipo` ⇒ ShopeeContaNotConfiguredError
 *     → a first-attempt terminal stamp: a real `failed` job doc
 *
 * ⚠️ Why a wrong-`tipo` conta specifically, and not a happier path. The lane's
 * non-localhost `fetch` kill-switch lives in the VITEST process and does NOT
 * cover the dispatched function, which runs in the emulator's own process — so
 * any path that reaches a Shopee call would really leave the runner. This one
 * cannot: `loadShopeeContext` refuses the conta on its `tipo` check BEFORE
 * `shopeeConfig()`, before the credential store and before a client exists, and
 * `resolverContexto` is the FIRST statement of the dispatch's `try`. Zero Shopee
 * calls by CALL ORDER, not by a mock — the same discipline
 * `../../../app/api/webhooks/shopee/route.tasks.test.ts` uses for its unmapped
 * shop. And the outcome still PERSISTS, so the assertion is about a document the
 * dispatched function wrote, not about the absence of one.
 *
 * What this proves that no `fakeDb` unit test can:
 *   - the SECOND queue is registered in the real artifact (a bundle built before
 *     step 9, or one whose `processShopeeMassImport` export was renamed on one
 *     side only, answers the enqueue with a 404);
 *   - the enqueue resolves the REGION-QUALIFIED queue path — the silent drop of
 *     #1108, which is the one failure mode that looks like success;
 *   - the payload survives the hop (the handler found the job the test seeded,
 *     under the integração the test named);
 *   - `finalizarImportacaoShopee`'s transaction — the ONE transaction of step 9 —
 *     really stamps against a real Firestore engine, not against `fakeDb`'s
 *     in-memory stand-in.
 *
 * ⚠️ NOT covered, and deliberately not asserted:
 *   - the BURST PAUSE. `ShopeeRateLimitError`'s `kind: 'burst'` re-enqueues with
 *     `scheduleDelaySeconds`, and the emulator IGNORES that option — dispatch is
 *     pure FIFO (firebase-tools#8254, open). So this suite can neither observe
 *     the pause nor be trusted about it; the burst arm is pinned offline in
 *     `importacaoMassa.test.ts`. Reaching it here would also require a real
 *     Shopee 429.
 *   - `retryConfig` / `rateLimits`. Emulated, but cheaper to assert off
 *     `__endpoint` — `functions/src/processMassImport.test.ts` does that.
 *   - the scan, the drain and the importer. Every one of them needs a Shopee
 *     call; they are unit-tested against `fakeDb`.
 *
 * ⚠️ The clock. This file reads `Date.now()` for exactly three TEST-LOCAL
 * purposes and no others: the seeded ms stamps, the poll's own deadline, and the
 * elapsed-time measurement. None of them is a production clock read, and no
 * module under `produtos/` reads a clock through this file. The seam's rule
 * (one clock read per dispatch, handed down as `nowMs`) is about the modules,
 * and the poll deadline is the same shape the precedent suite uses.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  importacaoShopeeCollection,
  integracaoCollection,
} from '@delfrance/data/admin/collections';
import {
  IMPORTACAO_SHOPEE_STATUS,
  INTEGRACAO_TIPO,
  OPCOES_IMPORTACAO_SHOPEE_PADRAO,
} from '@delfrance/schemas';

import { getAdminFirestore } from '../../firebase/admin';
import { cancelarImportacaoShopee } from './importacaoMassa';
import { createShopeeMassImportScheduler } from './shopeeMassImportTasks';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const JOBS = 'importacoesShopee';
const INTEGRACOES = 'integracao';

/** The one fixture conta. Never a real Shopee id, and never a real integração. */
const INTEGRACAO_ID = 'int-1';

/**
 * The first retry's floor, from `processMassImport.ts`'s
 * `retryConfig.minBackoffSeconds`. Nothing imports it — it lives on the deployed
 * function's options and this process never loads that module — so it is
 * restated here, and the elapsed-time assertion below is what would notice if
 * the two ever disagreed in the direction that matters (a LOWER floor there
 * would make the assertion weaker, never red, which is why the comment says the
 * number out loud).
 */
const BACKOFF_MINIMO_S = 30;

function db() {
  return getAdminFirestore();
}

/** A running job doc, every counter at zero — what the `importar-todos` route creates. */
function jobRodando(nowMs: number) {
  return {
    integracaoId: INTEGRACAO_ID,
    status: IMPORTACAO_SHOPEE_STATUS.running,
    nextOffset: null,
    fila: [],
    filaKits: [],
    scanned: 0,
    imported: 0,
    created: 0,
    skipped: 0,
    kits: 0,
    failureCount: 0,
    failures: [],
    options: {
      ...OPCOES_IMPORTACAO_SHOPEE_PADRAO,
      statuses: [...OPCOES_IMPORTACAO_SHOPEE_PADRAO.statuses],
    },
    startedAt: nowMs,
    updatedAt: nowMs,
    finishedAt: null,
    erro: null,
  };
}

/**
 * Poll the job doc until the DISPATCHED function moves it off `running`.
 *
 * The task travels enqueue → tasks emulator → functions emulator → handler, so
 * there is no promise to await, only the effect. A fixed sleep would be both
 * flaky and wrong in the other direction: `emulators:exec` tears the suite down
 * the moment the script exits, so waiting on the effect is also what keeps an
 * in-flight dispatch from being killed.
 *
 * ⚠️ Unlike the push suite's `waitForDoc`, the document EXISTS from the start
 * (this suite seeds it), so the wait is on the STATUS, not on arrival — and the
 * diagnostic has to say which of the two shapes it found.
 */
async function esperarSairDeRunning(
  jobId: string,
  timeoutMs = 45_000,
): Promise<FirebaseFirestore.DocumentData> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await db().collection(JOBS).doc(jobId).get();
    const data = snap.data();
    if (snap.exists && data && data.status !== IMPORTACAO_SHOPEE_STATUS.running) return data;
    if (Date.now() > deadline) {
      throw new Error(
        `o job ${jobId} continuou '${String(data?.status ?? '<documento sumiu>')}' por ` +
          `${String(timeoutMs)}ms — a função despachada nunca o carimbou. As três causas ` +
          'usuais, nesta ordem: (1) DERIVA DE REGIÃO — SHOPEE_TASKS_REGION (o enqueue) ' +
          'diferente do FUNCTIONS_REGION embutido no bundle, o descarte silencioso que ' +
          'shopeeMassImportTasks.ts descreve (#1108); (2) prepare-deploy.mjs NÃO rodou ' +
          'antes do emulators:exec, então .deploy/shopee-functions está velho ou ausente ' +
          '(emulators:exec não executa hooks predeploy); (3) a FILA não foi registrada — ' +
          'o emulador de functions é quem a cria a partir da definição do trigger, então ' +
          'sem ele, ou com o export processShopeeMassImport renomeado de um lado só, o ' +
          'enqueue dá 404. ⚠️ Se o enqueue tivesse falhado, o erro teria vindo dele, não ' +
          'daqui: chegar neste ponto significa que o Cloud Tasks ACEITOU a tarefa e nunca ' +
          'a entregou.',
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeEach(async () => {
  const jobs = await db().collection(JOBS).listDocuments();
  await Promise.all(jobs.map((r) => r.delete()));
  await db().collection(INTEGRACOES).doc(INTEGRACAO_ID).delete();
});

describe.skipIf(!EMULATED || !TASKS)(
  'importação em massa Shopee → Cloud Tasks → onTaskDispatched',
  () => {
    it('uma conta do tipo ERRADO carimba `failed` na PRIMEIRA tentativa, sem chamar a Shopee', async () => {
      const agoraMs = Date.now();

      // A conta that parses as a perfectly valid `integracao` and is simply not
      // Shopee. `ativo` and `nome` are the only fields that matter to the read;
      // everything else the schema defaults. ⚠️ `tipo` is an INT on disk, so the
      // named member is the only honest spelling (`prefer-schema-enum`).
      await integracaoCollection.set(db(), {}, INTEGRACAO_ID, {
        nome: 'Conta de teste — NÃO é Shopee',
        tipo: INTEGRACAO_TIPO.mercadoLivre,
        ativo: true,
      });

      // A fresh id per run so two runs inside one emulator session cannot
      // collide, and so a stale doc from a killed run cannot be mistaken for
      // this one's verdict.
      const jobId = `tasks-${randomUUID()}`;
      await importacaoShopeeCollection.set(db(), {}, jobId, jobRodando(agoraMs));

      // POSITIVE existence assertion, BEFORE the enqueue and before any polling.
      // `vitest.tasks.setup.ts` (3) spells out why this suite owes one: in the
      // emulator a mis-targeted database (`(default)` instead of `default`)
      // silently auto-creates, so every "not found" / "empty" assertion would
      // pass against an empty namespace. Reading the seed back proves the test
      // and the dispatched function are looking at the same database.
      const semeado = await db().collection(JOBS).doc(jobId).get();
      expect(semeado.exists).toBe(true);
      expect(semeado.data()).toMatchObject({
        status: IMPORTACAO_SHOPEE_STATUS.running,
        integracaoId: INTEGRACAO_ID,
      });

      const comecou = Date.now();
      // The REAL scheduler against the REAL emulated queue. A 404 here is a
      // finding, not a flake — see the three causes in `esperarSairDeRunning`.
      await createShopeeMassImportScheduler().enqueue({ jobId, integracaoId: INTEGRACAO_ID });

      const job = await esperarSairDeRunning(jobId);
      const decorridoMs = Date.now() - comecou;

      expect(job).toMatchObject({
        integracaoId: INTEGRACAO_ID,
        // ⚠️ `failed`, not `completed` and not `cancelled`. `completed` would
        // mean the dispatch resolved a context it had no business resolving;
        // `cancelled` has no writer in this test at all.
        status: IMPORTACAO_SHOPEE_STATUS.failed,
      });
      expect(typeof job.finishedAt).toBe('number');
      expect(job.finishedAt).toBeGreaterThan(0);

      // The MECHANISM is named in the stamp, because that sentence is the whole
      // of what an operator sees on the job card. `ShopeeContaNotConfiguredError`
      // is raised by `loadShopeeContext`'s `tipo` check, whose message is
      // `Integração <id> não é do tipo Shopee.` — so the row proves WHICH arm
      // fired, not merely that something failed.
      expect(typeof job.erro).toBe('string');
      expect(String(job.erro).length).toBeGreaterThan(0);
      expect(String(job.erro)).toContain('não é do tipo Shopee');
      expect(String(job.erro)).toContain(INTEGRACAO_ID);

      // Nothing was scanned, imported or contained: the dispatch died before the
      // scan page, so a non-zero counter here would mean the failure arrived
      // from somewhere further down than the context resolution.
      expect(job).toMatchObject({
        scanned: 0,
        imported: 0,
        created: 0,
        skipped: 0,
        kits: 0,
        failureCount: 0,
        failures: [],
        fila: [],
        filaKits: [],
        nextOffset: null,
      });

      // ⚠️ THIS is the proof that no Shopee call happened, and it is the only
      // one available: the kill-switch lives in THIS process and cannot see the
      // function's. The argument is the ladder's arithmetic. A first-attempt
      // class (`ehFalhaDePrimeiraTentativa`) stamps on attempt 0, so the doc
      // reaches `failed` inside ONE dispatch. A network or HTTP error — which is
      // what an escaped Shopee call would produce, with invented partner
      // credentials — is NOT in that set: it is rethrown into the queue's
      // ladder, and the earliest a stamp could then land is after
      // `minBackoffSeconds` (30 s) plus two more dispatches. So an elapsed time
      // comfortably under that floor is incompatible with any path that reached
      // the network.
      expect(decorridoMs).toBeLessThan(BACKOFF_MINIMO_S * 1000 - 5_000);
    });

    /**
     * The ONE transaction of step 9, on a REAL engine.
     *
     * `importacaoMassa.test.ts` drives `finalizarImportacaoShopee` against
     * `fakeDb`, whose transaction is a stand-in: it cannot show that
     * `parseRead`/`parseMerge` survive a real `tx.get` snapshot, that `tx.update`
     * is accepted on a document the callback just proved exists, or that the
     * handle's stored shape round-trips through Firestore's own types. This test
     * is cheap (no queue, no dispatch, no artifact) and answers exactly that.
     *
     * No enqueue, so nothing here depends on the tasks emulator beyond the
     * suite-level gate.
     */
    it('cancelar um job `running` responde `stamped` e o documento lê `cancelled` no Firestore real', async () => {
      const agoraMs = Date.now();
      const jobId = `cancel-${randomUUID()}`;
      await importacaoShopeeCollection.set(db(), {}, jobId, jobRodando(agoraMs));

      const resultado = await cancelarImportacaoShopee(db(), {
        jobId,
        integracaoId: INTEGRACAO_ID,
        now: agoraMs,
      });
      expect(resultado).toBe('stamped');

      const snap = await db().collection(JOBS).doc(jobId).get();
      expect(snap.exists).toBe(true);
      expect(snap.data()).toMatchObject({
        status: IMPORTACAO_SHOPEE_STATUS.cancelled,
        finishedAt: agoraMs,
        updatedAt: agoraMs,
        // A cancel is not a failure — `erro` stays null, which is what keeps the
        // job card from showing an error chip on an operator's own action.
        erro: null,
      });

      // ⛔ The near-miss: cancelling again is a NO-OP, not a second stamp. The
      // guard is re-derived from the `tx.get` snapshot, so the second call sees
      // `cancelled` and refuses — this is the property a plain `merge()` would
      // not have, and the one that keeps a dispatch finishing late from burying
      // the cancel under `completed` (rule 7).
      const segunda = await cancelarImportacaoShopee(db(), {
        jobId,
        integracaoId: INTEGRACAO_ID,
        now: agoraMs + 1,
      });
      expect(segunda).toBe('not-running');

      // …and the ownership check, on the same real engine: a caller naming
      // another conta gets `wrong-integracao` and writes nothing.
      const deOutraConta = await cancelarImportacaoShopee(db(), {
        jobId,
        integracaoId: 'int-2',
        now: agoraMs + 2,
      });
      expect(deOutraConta).toBe('wrong-integracao');

      const depois = await db().collection(JOBS).doc(jobId).get();
      expect(depois.data()).toMatchObject({
        status: IMPORTACAO_SHOPEE_STATUS.cancelled,
        finishedAt: agoraMs,
      });
    });
  },
);
