/**
 * The product import's first hop, end to end, against the real emulators (`ci-loja-integrada.yml`;
 * master plan step 9).
 *
 * What runs for real here, with nothing mocked:
 *
 *   a job document CREATED `pendente` in importacoesLojaIntegrada
 *     → onImportacaoLojaIntegradaCriada          the real deployed Firestore trigger
 *     → the real producer root → a NAMED task (`li-importacao-<jobId>-0`) on the
 *       region-qualified reads queue
 *     → Cloud Tasks emulator → Functions emulator
 *     → filaLeituraLojaIntegrada                 the real deployed onTaskDispatched
 *     → the raw `tipo: importacao` route → one import dispatch: the job read, the seq decision
 *     → the context refuses on the READ SWITCH (`off`, the job env)
 *     → the job stamped `falhou/chamadas-desligadas` by the dispatched function
 *
 * ⚠️ Why the switch refusal, and not a happier path. The lane's non-localhost `fetch` kill-switch
 * lives in the VITEST process and does not cover the dispatched function, which runs in the
 * emulator's own process. The context checks `LOJA_INTEGRADA_CHAMADAS` as its FIRST statement,
 * before any Firestore read of the conta and before a client exists, so the dispatch makes zero
 * platform calls by CALL ORDER — while its outcome still PERSISTS on the job.
 *
 * Why NO conta is seeded: the motivo is then discriminating. Were the switch checked after the
 * conta read, the same dispatch would end `conta-indisponivel` (no such conta); only a refusal at
 * the switch writes `chamadas-desligadas`. And this suite writes no `integracao` doc, so the conta
 * trigger never fires for it; it writes no `produtolojaintegrada` doc either.
 *
 * What this proves that no offline test can:
 *   - the trigger is registered in the real artifact on the real path and database, and the
 *     emulator delivers a CREATE of a job document to it;
 *   - its enqueue resolves the REGION-QUALIFIED reads queue (the silent drop of #1108) with a NAMED
 *     task the emulator accepts;
 *   - the dispatched bundle routes the raw `tipo` to the import, carries the dispatch, its job
 *     lifecycle and the context's switch, and its terminal stamp lands on the real server;
 *   - a job created in ANY other status is left alone by the trigger (case 2), proved by a LATER
 *     sentinel, never by polling for an absence.
 *
 * ⚠️ NOT covered, and deliberately not asserted:
 *   - named-task dedup (the emulator accepts a named enqueue; a duplicate's answer is not
 *     asserted): the producer's and the trigger's unit tests pin the rule;
 *   - `scheduleDelaySeconds` (firebase-tools#8254), so the continuation's 2 s and the pause's 60 s
 *     are pinned offline only;
 *   - any slice past the switch: that needs the switch on, which this lane never turns on.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { importacaoLojaIntegradaSchema } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const JOBS = 'importacoesLojaIntegrada';
/** This suite's own conta and job ids: no other suite seeds them, and no conta doc is written. */
const CONTA_ID = 'conta-li-importacao-ci';
const JOB_PENDENTE = 'jobImportacaoCiPendente01';
const JOB_EXECUTANDO = 'jobImportacaoCiExecutando1';
const JOB_SENTINELA = 'jobImportacaoCiSentinela01';
const INICIO_MS = Date.UTC(2026, 10, 4, 12, 0, 0);

function db() {
  return getAdminFirestore();
}

function aguardar(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A job document of this suite's conta, parsed whole through the job schema. */
function job(status: 'pendente' | 'executando') {
  return importacaoLojaIntegradaSchema.parse({
    integracaoId: CONTA_ID,
    iniciadoPor: 'u-ci',
    iniciadoEmMs: INICIO_MS,
    atualizadoEmMs: INICIO_MS,
    status,
  });
}

/**
 * Poll for the job the DISPATCHED function stamps, until `pronto` holds. The event travels
 * trigger → tasks emulator → functions emulator → handler, so there is no promise to await.
 */
async function aguardarJob(
  jobId: string,
  pronto: (d: FirebaseFirestore.DocumentData) => boolean,
  timeoutMs = 45_000,
): Promise<FirebaseFirestore.DocumentData> {
  const prazo = Date.now() + timeoutMs;
  for (;;) {
    const snap = await db().collection(JOBS).doc(jobId).get();
    const dados = snap.exists ? (snap.data() ?? {}) : null;
    if (dados !== null && pronto(dados)) return dados;
    if (Date.now() > prazo) {
      throw new Error(
        `a importação ${jobId} não chegou ao estado esperado em ${String(timeoutMs)}ms ` +
          `(atual: ${dados === null ? '<ausente>' : JSON.stringify({ status: dados.status, motivo: dados.motivo, seq: dados.seq })}). ` +
          'Ainda `pendente`: confira que o gatilho onImportacaoLojaIntegradaCriada está no artefato ' +
          '(prepare-deploy.mjs antes do emulators:exec), que LOJA_INTEGRADA_TASKS_REGION é igual ao ' +
          'FUNCTIONS_REGION embutido no bundle (o descarte silencioso do #1108) e que ' +
          'LOJA_INTEGRADA_TASKS_DISABLED não está em 1 (.github/workflows/ci-loja-integrada.yml).',
      );
    }
    await aguardar(250);
  }
}

describe.skipIf(!EMULATED || !TASKS)(
  'importação de produtos da Loja Integrada → gatilho de criação → Cloud Tasks → fila de leitura',
  () => {
    beforeAll(() => {
      // Initialise the admin app FIRST, with the project pinned by the setup file.
      db();
    });

    beforeEach(async () => {
      for (const id of [JOB_PENDENTE, JOB_EXECUTANDO, JOB_SENTINELA]) {
        await db().recursiveDelete(db().collection(JOBS).doc(id));
      }
    });

    it('um job criado `pendente` vira UMA tarefa nomeada, e o despacho para na chave de leitura: `falhou/chamadas-desligadas`, nenhuma chamada', async () => {
      // The lane's own precondition, from the same shell the emulator got.
      expect(
        process.env.LOJA_INTEGRADA_CHAMADAS,
        'ci-loja-integrada.yml define LOJA_INTEGRADA_CHAMADAS=off para esta suíte',
      ).not.toBe('on');

      await db().collection(JOBS).doc(JOB_PENDENTE).create(job('pendente'));

      const dados = await aguardarJob(JOB_PENDENTE, (d) => d.status === 'falhou');
      expect(dados).toMatchObject({
        integracaoId: CONTA_ID,
        // ⚠️ `chamadas-desligadas`, never `conta-indisponivel`: no conta exists, so only a refusal
        // at the switch — the context's first act — writes this motivo (header).
        status: 'falhou',
        motivo: 'chamadas-desligadas',
        // Dispatch 0 ended at the switch: nothing checkpointed, nothing handed off.
        seq: 0,
        fase: 'catalogo',
      });
      // Stamped by the dispatched function inside the emulator, not by this process.
      expect(dados.concluidoEmMs).toBeGreaterThan(INICIO_MS);
    });

    it('um job criado `executando` é ignorado pelo gatilho — provado por uma sentinela criada DEPOIS', async () => {
      const ref = db().collection(JOBS).doc(JOB_EXECUTANDO);
      const { writeTime } = await ref.create(job('executando'));
      await db().collection(JOBS).doc(JOB_SENTINELA).create(job('pendente'));

      // POSITIVE first: the sentinel, created AFTER, went all the way round.
      await aguardarJob(JOB_SENTINELA, (d) => d.status === 'falhou');
      // A moment for an in-flight dispatch of the earlier job to land, were there one.
      await aguardar(2_000);

      const snap = await ref.get();
      expect(snap.data()).toMatchObject({ status: 'executando', seq: 0, motivo: null });
      // Not a single write since its create: no dispatch ever touched it.
      expect(snap.updateTime?.isEqual(writeTime)).toBe(true);
    });
  },
);
