/**
 * The daily stock reconcile's PRODUCER, pure (master plan step 12, PR 12-g): what an enqueue of one
 * reconcile slice onto the READS queue (`filaLeituraLojaIntegrada`) means, with the transport
 * handed in — the import's producer's contract (`importacao/agendadorImportacao.ts`), for the
 * `estoque-reconcile` task. The queue is bound by a composition root in the functions codebase
 * (`functions/src/agendador.ts`), through the reads root's own region and valve readers; nothing
 * here reads the process environment.
 *
 * ## Every task is NAMED: `idTarefaReconcileEstoqueLi(execucaoId, seq)`
 *
 * Derived HERE from the payload, never passed in. A scheduler retry of the same night, a retried
 * slice re-enqueueing its successor and the continuation check's repair all enqueue the SAME task,
 * so only one runs; a duplicate that slips past the name finds the run document's `seq` already
 * moved and does nothing (`execucaoReconcile.ts`).
 *
 * ## The delay — the import's three values, never a knob
 *
 * `0` (a run's first slice), `ATRASO_CONTINUACAO_IMPORTACAO_LI_S` (2 s: an ordinary hand-off, so
 * an order-intake task already waiting runs first) and `ATRASO_PAUSA_429_IMPORTACAO_LI_S` (60 s:
 * after a 429, and for every hand-off whose owner's delay is unknown — the repair). Anything else
 * is refused before the queue is resolved (`RangeError`). ⚠️ The functions emulator ignores
 * `scheduleDelaySeconds` (firebase-tools#8254): pinned offline only.
 *
 * ## What a rejection MEANS
 *
 * An answered `functions/task-already-exists` is SUCCESS; the closed sweep-only valve is
 * `LiTarefasDesligadasError` (the queue never resolved); a transient Cloud Tasks failure is
 * `LiTarefasTransitoriasError` (the reads producer's own naming); anything else is rethrown as
 * thrown. The payload is `{ tipo: 'estoque-reconcile', execucaoId, seq }`, parsed strict before
 * the queue is resolved; no `uri`.
 */
import {
  type TarefaReconcileEstoqueLi,
  idTarefaReconcileEstoqueLi,
  tarefaReconcileEstoqueLiSchema,
} from '@delfrance/schemas';

import {
  ATRASO_CONTINUACAO_IMPORTACAO_LI_S,
  ATRASO_PAUSA_429_IMPORTACAO_LI_S,
} from '../../importacao/agendadorImportacao';
import {
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
  enfileirarNomeandoFalhaTransitoriaLi,
  tarefaJaExisteLi,
} from '../../notificacoes/agendador';

export { LiTarefasDesligadasError, LiTarefasTransitoriasError };

/** The only delays a slice may be enqueued with (module header). */
const ATRASOS_PERMITIDOS: ReadonlySet<number> = new Set([
  0,
  ATRASO_CONTINUACAO_IMPORTACAO_LI_S,
  ATRASO_PAUSA_429_IMPORTACAO_LI_S,
]);

/** What the transport's enqueue takes besides the payload (the Admin SDK's `TaskOptions` subset). */
export interface OpcoesEnfileiramentoReconcileLi {
  readonly id: string;
  readonly scheduleDelaySeconds?: number;
}

/** The transport, as a root binds it: structurally, the Admin SDK's `TaskQueue`. */
export interface FilaReconcileEstoqueLi {
  enqueue(tarefa: TarefaReconcileEstoqueLi, opcoes: OpcoesEnfileiramentoReconcileLi): Promise<void>;
}

/** The enqueue seam a slice and the schedule depend on: a fake in tests, the producer for real. */
export interface AgendadorReconcileEstoqueLi {
  enfileirar(tarefa: TarefaReconcileEstoqueLi, pedido: { readonly atrasoS: number }): Promise<void>;
}

export interface OpcoesAgendadorReconcileEstoqueLi {
  /** The queue, resolved PER ENQUEUE and only when the valve is open. */
  readonly fila: () => FilaReconcileEstoqueLi;
  /** The sweep-only valve, as the root read it (exactly `'1'` closes it). */
  readonly desligado: boolean;
}

/** The producer (module header). */
export function criarAgendadorReconcileEstoqueLi(
  opcoes: OpcoesAgendadorReconcileEstoqueLi,
): AgendadorReconcileEstoqueLi {
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
        throw new RangeError(`agendadorReconcile: atraso não permitido (${String(atrasoS)} s)`);
      }
      const payload = tarefaReconcileEstoqueLiSchema.parse(tarefa);
      const id = idTarefaReconcileEstoqueLi(payload.execucaoId, payload.seq);
      const envio: OpcoesEnfileiramentoReconcileLi =
        atrasoS === 0 ? { id } : { id, scheduleDelaySeconds: atrasoS };
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
