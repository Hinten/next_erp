/**
 * The product import's PRODUCER, pure (master plan step 9): what an enqueue of one import dispatch
 * onto the conta's READS queue (`filaLeituraLojaIntegrada`) means, with the transport handed in.
 *
 * The queue is bound by a composition root in the functions codebase, never here: it resolves the
 * region-qualified queue path through the reads root's own readers and reads the sweep-only valve,
 * and passes both in as {@link OpcoesAgendadorImportacaoLi}. Nothing in this module reads the
 * process environment (`estrutura.test.ts`). Two callers enqueue through it, both in the functions
 * codebase: the job-creation trigger (dispatch 0) and a dispatch handing off to the next one.
 *
 * ## Every task is NAMED: `idTarefaImportacaoLi(jobId, seq)`
 *
 * The task id is derived HERE from the payload, never passed in, so no caller can enqueue dispatch
 * `seq` of a job under another name. Cloud Tasks refuses a second task of one name, so the three
 * ways one hand-off can be attempted twice — a trigger redelivery, a retried dispatch re-enqueueing
 * its successor, and the continuation check (a retry that finds its own end-of-dispatch checkpoint
 * already stored) — all enqueue the SAME task, and only one runs. A duplicate that slips past the
 * name anyway (Cloud Tasks forgets a name some time after the task ran) finds the job's stored
 * `seq` already moved and does nothing.
 *
 * ## The delay
 *
 * `atrasoS` becomes `scheduleDelaySeconds`, and `0` sends none (the first dispatch runs at once):
 *
 *  - {@link ATRASO_CONTINUACAO_IMPORTACAO_LI_S} (2 s) for an ordinary hand-off: an order-intake
 *    task already waiting on the queue is then strictly OLDER than the import's next dispatch, so
 *    it runs first (Cloud Tasks orders by schedule time, best effort) and waits at most one import
 *    dispatch;
 *  - {@link ATRASO_PAUSA_429_IMPORTACAO_LI_S} (60 s) after Loja Integrada answered 429: the next
 *    dispatch starts in a fresh minute of the store's rate window.
 *
 * Any other value is refused before the queue is resolved (`RangeError`): the delay is a decision
 * of this module, not a knob. ⚠️ The functions emulator ignores `scheduleDelaySeconds`
 * (firebase-tools#8254), so the delays are pinned offline only.
 *
 * ## What a rejection MEANS — part of the contract
 *
 *  - `functions/task-already-exists` WITH an answered `httpResponse` is SUCCESS: the dispatch this
 *    call meant to queue is already queued (`tarefaJaExisteLi`, shared with the writes producer).
 *  - {@link LiTarefasDesligadasError} — the sweep-only valve (`LOJA_INTEGRADA_TASKS_DISABLED=1`) is
 *    closed, and the queue was never resolved. The caller stamps the job `falhou` with
 *    `tarefas-desligadas`: an import is never left `executando` with nothing queued.
 *  - {@link LiTarefasTransitoriasError} — Cloud Tasks hiccupped. The caller THROWS, and its own
 *    retry re-attempts the same named enqueue (the continuation check, for a dispatch).
 *  - anything else, rethrown EXACTLY as thrown — a broken deploy, a root's region guard, a coding
 *    bug. It must fail loudly.
 *
 * The transient naming is the reads producer's own (`enfileirarNomeandoFalhaTransitoriaLi`), so the
 * queues cannot classify a Cloud Tasks failure differently.
 *
 * ## The payload goes alone, ids only
 *
 * `{ tipo: 'importacao', contaId, jobId, seq }`, parsed through `tarefaImportacaoLiSchema` before
 * the queue is resolved (unknown keys stripped; a malformed id refused with the `ZodError`). No
 * `uri`: under the emulator the Admin SDK sends an empty URL the emulator fills in, so a supplied
 * one would ship the task to the deployed function instead.
 */
import {
  type TarefaImportacaoLi,
  idTarefaImportacaoLi,
  tarefaImportacaoLiSchema,
} from '@delfrance/schemas';

import {
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
  enfileirarNomeandoFalhaTransitoriaLi,
  tarefaJaExisteLi,
} from '../notificacoes/agendador';

export { LiTarefasDesligadasError, LiTarefasTransitoriasError };

/** The delay of an ordinary hand-off to the next dispatch, in seconds (module header). */
export const ATRASO_CONTINUACAO_IMPORTACAO_LI_S = 2;

/** The delay after a 429, in seconds: the next dispatch starts in a fresh minute. */
export const ATRASO_PAUSA_429_IMPORTACAO_LI_S = 60;

/** The only delays a dispatch may be enqueued with: none (the first), a hand-off, a 429 pause. */
const ATRASOS_PERMITIDOS: ReadonlySet<number> = new Set([
  0,
  ATRASO_CONTINUACAO_IMPORTACAO_LI_S,
  ATRASO_PAUSA_429_IMPORTACAO_LI_S,
]);

/** What the transport's enqueue takes besides the payload (the Admin SDK's `TaskOptions` subset). */
export interface OpcoesEnfileiramentoImportacaoLi {
  readonly id: string;
  readonly scheduleDelaySeconds?: number;
}

/**
 * The transport, as a root binds it — structurally, the Admin SDK's
 * `TaskQueue<TarefaImportacaoLi>`, of which only `enqueue(data, { id, scheduleDelaySeconds })` is
 * used.
 */
export interface FilaImportacaoLi {
  enqueue(tarefa: TarefaImportacaoLi, opcoes: OpcoesEnfileiramentoImportacaoLi): Promise<void>;
}

/** What one enqueue asks for besides the payload. */
export interface PedidoEnfileiramentoImportacaoLi {
  /** `0`, {@link ATRASO_CONTINUACAO_IMPORTACAO_LI_S} or {@link ATRASO_PAUSA_429_IMPORTACAO_LI_S}. */
  readonly atrasoS: number;
}

/** The enqueue seam a dispatch and the trigger depend on: a fake in tests, {@link criarAgendadorImportacaoLi} for real. */
export interface AgendadorImportacaoLi {
  enfileirar(tarefa: TarefaImportacaoLi, pedido: PedidoEnfileiramentoImportacaoLi): Promise<void>;
}

export interface OpcoesAgendadorImportacaoLi {
  /**
   * The queue, resolved PER ENQUEUE and only when the valve is open: a root's region guard then
   * rejects that enqueue (rethrown untouched) instead of failing the whole module load.
   */
  readonly fila: () => FilaImportacaoLi;
  /** The sweep-only valve, as the root read it (exactly `'1'` closes it). */
  readonly desligado: boolean;
}

/**
 * The producer: with the valve closed, every enqueue rejects with {@link LiTarefasDesligadasError}
 * and the queue is never resolved; otherwise each enqueue validates the delay and the payload,
 * sends the payload WITH its derived task id (and the delay, when not 0), treats an answered
 * already-exists as success and names a transient failure.
 */
export function criarAgendadorImportacaoLi(
  opcoes: OpcoesAgendadorImportacaoLi,
): AgendadorImportacaoLi {
  if (opcoes.desligado) {
    return {
      async enfileirar() {
        throw new LiTarefasDesligadasError();
      },
    };
  }
  return {
    async enfileirar(tarefa, { atrasoS }) {
      if (!ATRASOS_PERMITIDOS.has(atrasoS)) {
        throw new RangeError(`agendadorImportacao: atraso não permitido (${String(atrasoS)} s)`);
      }
      const payload = tarefaImportacaoLiSchema.parse(tarefa);
      const envio: OpcoesEnfileiramentoImportacaoLi =
        atrasoS === 0
          ? { id: idTarefaImportacaoLi(payload.jobId, payload.seq) }
          : { id: idTarefaImportacaoLi(payload.jobId, payload.seq), scheduleDelaySeconds: atrasoS };
      await enfileirarNomeandoFalhaTransitoriaLi(async () => {
        try {
          await opcoes.fila().enqueue(payload, envio);
        } catch (err) {
          if (tarefaJaExisteLi(err)) return;
          throw err;
        }
      });
    },
  };
}
