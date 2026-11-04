/**
 * The writes-queue PRODUCER, pure (master plan step 7, PR 7-d): what an enqueue
 * onto `filaEscritaLojaIntegrada` means, with the transport handed in, and how a
 * write event is NAMED.
 *
 * The queue itself is bound by a composition root in the functions codebase,
 * never here (master plan step 7, PR 7-e): it resolves the region-qualified
 * queue path and reads the sweep-only valve, and passes both in as
 * {@link OpcoesAgendadorEscritaLi}. Nothing in this module reads the process
 * environment (`estrutura.test.ts`).
 *
 * ## The naming: digests, never the source ids
 *
 *  - The event id is {@link eventoDoHistoricoLi}: `sha256('historico:' + pedidoId
 *    + '/' + historicoId)`, lowercase hex. The literal prefix keeps a namespace,
 *    so a later producer gets its own id space without a payload field; the
 *    digest makes the id valid whatever characters the source ids hold.
 *  - The failure document's id is the event id; the Cloud Tasks task id is
 *    `rastreio-<evento>` ({@link idDaTarefaEscritaLi}), inside Cloud Tasks'
 *    `[A-Za-z0-9_-]{1,500}` by construction.
 *
 * Unlike the reads producer (`notificacoes/agendador.ts`, which names no task),
 * this one NAMES its tasks: a redelivered source event within Cloud Tasks' dedup
 * window (about an hour after the task ran) collides instead of queueing a
 * second write. Past that window, idempotency is the run's own — every attempt
 * decides from a fresh read of Loja Integrada and skips what is already there.
 *
 * ## The queue's second task: the varredura
 *
 * The writes queue also carries its own sweep (PR 7-e): a scheduler enqueues
 * ONE `{ tipo: 'varredura' }` task per tick, and the queue runs both lanes of
 * the failure store inside its single dispatch slot, so a retry can never race
 * a fresh write. That task holds no payload beyond its tipo, it is dispatched
 * by name BEFORE any parse (the payload schema refuses it), and it is named
 * after its tick ({@link idDaTarefaVarreduraEscritaLi}), so a scheduler's
 * redelivery of the same tick collides instead of sweeping twice.
 *
 * ## What a rejection MEANS — part of the contract
 *
 *  - `functions/task-already-exists` WITH an answered `httpResponse` (the 409
 *    the SDK maps) is SUCCESS: the same event is already queued. Never a
 *    failure, never persisted. (The reads producer must keep rethrowing it — it
 *    never names a task, so for it the code cannot happen.)
 *  - {@link LiTarefasDesligadasError} — the sweep-only valve is closed: the
 *    caller persists the event as `failed`, and it runs once tasks are enabled
 *    again (the writes sweep is a task too).
 *  - {@link LiTarefasTransitoriasError} — Cloud Tasks hiccupped: the caller
 *    persists, exactly as above.
 *  - anything else, rethrown EXACTLY as thrown — a broken deploy, a root's region
 *    guard, a coding bug. It must fail loudly.
 *
 * The transient naming is the reads producer's own
 * (`enfileirarNomeandoFalhaTransitoriaLi`), so the two queues cannot classify a
 * Cloud Tasks failure differently.
 */
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import { sha256Hex } from '@delfrance/data/admin';

import {
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
  enfileirarNomeandoFalhaTransitoriaLi,
} from '../notificacoes/agendador';
import type { PayloadTarefaEscritaLi } from './notificacaoEscrita';

export { LiTarefasDesligadasError, LiTarefasTransitoriasError };

/** The SDK's code for a named task Cloud Tasks already holds (an answered 409). */
const CODIGO_TAREFA_JA_EXISTE = 'functions/task-already-exists';

/** The event id of a freight history row (module header). */
export function eventoDoHistoricoLi(pedidoId: string, historicoId: string): string {
  return sha256Hex(`historico:${pedidoId}/${historicoId}`);
}

/** The Cloud Tasks task id of a write event: `rastreio-<evento>` (module header). */
export function idDaTarefaEscritaLi(
  payload: Pick<PayloadTarefaEscritaLi, 'tipo' | 'evento'>,
): string {
  return `${payload.tipo}-${payload.evento}`;
}

/**
 * The `tipo` of the writes queue's sweep task (module header). Deliberately NOT
 * a member of the payload's `tipoTarefaEscritaLiSchema`: the queue dispatches
 * it by this name before any parse, and the pipeline would drop it.
 */
export const TIPO_TAREFA_VARREDURA_ESCRITA_LI = 'varredura';

/** The varredura task: its tipo and nothing else. */
export interface TarefaVarreduraEscritaLi {
  readonly tipo: typeof TIPO_TAREFA_VARREDURA_ESCRITA_LI;
}

/** Everything the writes queue carries: a write event, or its sweep. */
export type TarefaFilaEscritaLi = PayloadTarefaEscritaLi | TarefaVarreduraEscritaLi;

/**
 * The Cloud Tasks task id of the varredura of one tick: `varredura-<the digits
 * of the tick's schedule time>` (`2026-10-26T15:15:00.000Z` →
 * `varredura-20261026151500000`), inside `[A-Za-z0-9_-]` by construction.
 * The scheduler stamps the same schedule time on a redelivery of the same tick,
 * so the two collide; the next tick is another instant, so another id.
 *
 * `null` when the value holds no digit: a bare `varredura-` would collide with
 * EVERY tick for as long as Cloud Tasks keeps the name, silently skipping the
 * sweep — the caller picks another instant instead.
 */
export function idDaTarefaVarreduraEscritaLi(horaAgendada: string): string | null {
  const digitos = horaAgendada.replace(/[^0-9]/g, '');
  return digitos === '' ? null : `${TIPO_TAREFA_VARREDURA_ESCRITA_LI}-${digitos}`;
}

/** What the enqueue takes besides the payload: the task's own id. */
export interface OpcoesEnfileiramentoEscritaLi {
  readonly id: string;
}

/**
 * The transport, as a root binds it — structurally, the Admin SDK's
 * `TaskQueue<TarefaFilaEscritaLi>`, of which only `enqueue(data, { id })` is used.
 */
export interface FilaEscritaLi {
  enqueue(tarefa: TarefaFilaEscritaLi, opcoes: OpcoesEnfileiramentoEscritaLi): Promise<void>;
}

/** The enqueue seam a producer depends on: a fake in tests, {@link criarAgendadorEscritaLi} for real. */
export interface AgendadorEscritaLi {
  enfileirar(tarefa: TarefaFilaEscritaLi, opcoes: OpcoesEnfileiramentoEscritaLi): Promise<void>;
}

export interface OpcoesAgendadorEscritaLi {
  /**
   * The queue, resolved PER ENQUEUE and only when the valve is open: a root's
   * region guard then rejects that enqueue (rethrown untouched) instead of
   * failing the whole module load.
   */
  readonly fila: () => FilaEscritaLi;
  /** The sweep-only valve, as the root read it (exactly `'1'` closes it). */
  readonly desligado: boolean;
}

/** Whether `err` is the SDK's answered "a task with this id already exists". */
function tarefaJaExiste(err: unknown): boolean {
  return (
    err instanceof FirebaseFunctionsError &&
    err.code === CODIGO_TAREFA_JA_EXISTE &&
    err.httpResponse !== undefined
  );
}

/**
 * The producer: with the valve closed, every enqueue rejects with
 * {@link LiTarefasDesligadasError} and the queue is never resolved; otherwise
 * each enqueue sends the payload WITH its task id, treats an answered
 * already-exists as success, and names a transient failure.
 */
export function criarAgendadorEscritaLi(opcoes: OpcoesAgendadorEscritaLi): AgendadorEscritaLi {
  if (opcoes.desligado) {
    return {
      async enfileirar() {
        throw new LiTarefasDesligadasError();
      },
    };
  }
  return {
    enfileirar: (tarefa, { id }) =>
      enfileirarNomeandoFalhaTransitoriaLi(async () => {
        try {
          await opcoes.fila().enqueue(tarefa, { id });
        } catch (err) {
          if (tarefaJaExiste(err)) return;
          throw err;
        }
      }),
  };
}
