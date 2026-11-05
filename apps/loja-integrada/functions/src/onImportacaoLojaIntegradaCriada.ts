import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';

import {
  MOTIVO_FALHA_IMPORTACAO_LI,
  STATUS_IMPORTACAO_LI,
  TIPO_TAREFA_IMPORTACAO_LI,
  importacaoLojaIntegradaMeta,
  statusImportacaoLiSchema,
  tarefaImportacaoLiSchema,
} from '@delfrance/schemas';

import {
  type AgendadorImportacaoLi,
  LiTarefasDesligadasError,
} from '../../lib/lojaIntegrada/importacao/agendadorImportacao';
import { encerrarImportacaoLi } from '../../lib/lojaIntegrada/importacao/job';
import { criarAgendadorImportacaoLiDoAmbiente } from './agendador';
import { getDb } from './lib/admin';

const TAG = '[loja-integrada] onImportacaoLojaIntegradaCriada';

/** Everything one fire needs — injected so the test drives every arm with doubles. */
export interface DepsGatilhoImportacaoLi {
  /** Resolved LAZILY: only the closed-valve stamp touches Firestore. */
  readonly db: () => Firestore;
  /** Built only for a `pendente` job — the sweep-only valve is read when it is built. */
  readonly agendador: () => AgendadorImportacaoLi;
  /** The closed-valve stamp's clock, in ms. */
  readonly agoraMs: () => number;
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

/** One created job document, as the trigger received it. */
export interface ImportacaoCriadaLi {
  readonly jobId: string;
  /** The created document's RAW body; `undefined` when the event carried none. */
  readonly dados: Record<string, unknown> | undefined;
}

/** What one fire did. */
export type ResultadoGatilhoImportacaoLi =
  /** Not created `pendente`: nothing read, nothing enqueued, no line. */
  | 'ignorado'
  /** Dispatch 0 is on the reads queue (or already was: a redelivery). */
  | 'enfileirado'
  /** The created document cannot name its task (a hand-written one): nothing enqueued. */
  | 'payload-invalido'
  /** The tasks valve is closed: the job was stamped `falhou/tarefas-desligadas`. */
  | 'tarefas-desligadas'
  /** The valve is closed, but the job no longer runs at dispatch 0 (a cancel won): nothing stamped. */
  | 'parado';

/**
 * T1–T3 for ONE created job document — see {@link onImportacaoLojaIntegradaCriada}. Rethrows what
 * Eventarc must retry.
 */
export async function tratarImportacaoCriadaLi(
  deps: DepsGatilhoImportacaoLi,
  criado: ImportacaoCriadaLi,
): Promise<ResultadoGatilhoImportacaoLi> {
  // ---- T1: ONLY a job created `pendente`. Zero reads, and NO line: every emulator suite seeds
  // `executando` jobs precisely so this trigger leaves them alone. ----
  const status = statusImportacaoLiSchema.safeParse(criado.dados?.status);
  if (!status.success || status.data !== STATUS_IMPORTACAO_LI.pendente) return 'ignorado';

  // ---- T2: dispatch 0's payload, ids only, through the task schema. ----
  const lido = tarefaImportacaoLiSchema.safeParse({
    tipo: TIPO_TAREFA_IMPORTACAO_LI,
    contaId: criado.dados?.integracaoId,
    jobId: criado.jobId,
    seq: 0,
  });
  if (!lido.success) {
    // Deterministic: no retry could make it valid. The field NAMES only, never a value.
    deps.logger.warn(`${TAG} job fora do formato da tarefa; nada enfileirado`, {
      jobId: criado.jobId,
      campos: [...new Set(lido.error.issues.map((i) => String(i.path[0])))].sort(),
    });
    return 'payload-invalido';
  }
  const ids = { jobId: lido.data.jobId, contaId: lido.data.contaId };

  // ---- T3: the NAMED enqueue (`idTarefaImportacaoLi(jobId, 0)`). ----
  try {
    await deps.agendador().enfileirar(lido.data, { atrasoS: 0 });
  } catch (err) {
    if (!(err instanceof LiTarefasDesligadasError)) throw err;
    // Never a job left `pendente` with nothing queued: it ends, and says why.
    const r = await encerrarImportacaoLi(
      deps.db(),
      { jobId: lido.data.jobId, seq: 0, versao: null },
      {
        status: STATUS_IMPORTACAO_LI.falhou,
        motivo: MOTIVO_FALHA_IMPORTACAO_LI.tarefasDesligadas,
      },
      deps.agoraMs(),
    );
    deps.logger.warn(`${TAG} tarefas desligadas; importação encerrada`, {
      ...ids,
      encerrada: r.tipo === 'encerrado',
    });
    return r.tipo === 'encerrado' ? 'tarefas-desligadas' : 'parado';
  }
  deps.logger.info(`${TAG} enfileirado`, ids);
  return 'enfileirado';
}

/**
 * The product import's job-creation TRIGGER (master plan step 9): it turns a job document the start
 * route created `pendente` into ONE named task on the reads queue — dispatch 0 — and the dispatch
 * (never this function) does the work. The start route itself never touches Cloud Tasks, so App
 * Hosting needs no queue grant and no region for the import.
 *
 * It fires on EVERY create of `importacoesLojaIntegrada/{jobId}`, and enqueues ONLY a document
 * created `pendente`: a document created in any other status (every emulator suite seeds
 * `executando`, so no dispatch races its assertions) returns with ZERO reads and no line.
 *
 *  - **T1** the created document's `status`, raw: exactly `pendente`, else return.
 *  - **T2** the payload `{ tipo: 'importacao', contaId: <integracaoId>, jobId, seq: 0 }` through
 *    `tarefaImportacaoLiSchema`: a document that cannot name its task logs ONE WARNING with field
 *    names and enqueues nothing.
 *  - **T3** the enqueue through the producer root, NAMED `idTarefaImportacaoLi(jobId, 0)`: a
 *    redelivery of this event enqueues the SAME task, and an answered already-exists is success.
 *    The sweep-only valve closed (`LOJA_INTEGRADA_TASKS_DISABLED=1`) stamps the job
 *    `falhou/tarefas-desligadas` (read-decide-write at dispatch 0, so a cancel that won is never
 *    overwritten); a transient Cloud Tasks failure, and anything else — a missing region, a refused
 *    permission — is rethrown for Eventarc's retry.
 *
 * ⚠️ Targets the NAMED `default` database, inlined at build time by `build.mjs`
 * (`onIntegracaoLojaIntegradaChanged`'s docblock says why): an `onDocument*` bound to `(default)`
 * deploys fine and NEVER fires. `retry: true`: the named task makes a retried enqueue idempotent.
 * No `region:` (options.ts), no `secrets:` (it never calls Loja Integrada — the read switch is the
 * dispatch's first act), no memory or timeout of its own.
 *
 * LOGS: the job and conta ids only.
 */
export const onImportacaoLojaIntegradaCriada = onDocumentCreated(
  {
    // The meta, never a literal: `importacoesLojaIntegrada`.
    document: `${importacaoLojaIntegradaMeta.collectionPath}/{jobId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    retry: true,
    // ⚠️ No `region:` (options.ts) and no `secrets:` — see the docblock.
  },
  async (event) => {
    const { jobId } = event.params;
    const dados = event.data?.exists
      ? (event.data.data() as Record<string, unknown> | undefined)
      : undefined;

    await tratarImportacaoCriadaLi(
      {
        db: getDb,
        agendador: criarAgendadorImportacaoLiDoAmbiente,
        agoraMs: () => Date.now(),
        logger,
      },
      { jobId, dados },
    );
  },
);
