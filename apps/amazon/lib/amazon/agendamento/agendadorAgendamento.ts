/**
 * The Easy Ship scheduling queue's PRODUCER, pure (step 15, PR 15-c): what an
 * enqueue onto `processAmazonEasyShipSchedule` ({@link FILA_AGENDAMENTO_AMAZON})
 * means, with the transport handed in. Modelled on the NF-e producer
 * (`nfe/agendadorNfe.ts`), and different where an entry is: an E1 observation
 * with no task id goes unnamed, a named enqueue may carry a delay, a 409 means
 * "already there" only for a named enqueue, and an observation must be the
 * payload's own.
 *
 * The queue itself is bound by a COMPOSITION ROOT, never here: the functions
 * codebase's `functions/src/agendadorAgendamento.ts`, the app's FOURTH
 * `getFunctions(` caller (step-15 plan §3 decision 23), for the two entries —
 * the NF-e task's acceptance seam (E1) and the order import (E2) — and for the
 * scheduling task's own re-enqueues. The root resolves the region, builds the
 * path with {@link caminhoDaFilaAgendamentoAmazon}, reads the queue valve and
 * passes both in as {@link OpcoesAgendadorAgendamentoAmazon}. Nothing here
 * reads the process environment or imports the Cloud Tasks SDK: the transport
 * is STRUCTURAL ({@link FilaAgendamentoAmazon}), and the SDK knowledge is
 * `core/filaTarefas.ts`'s.
 *
 * ## Two entry points, and only ONE names its task
 *
 * - {@link AgendadorAgendamentoAmazon.enfileirarEntrada} — an ENTRY's enqueue
 *   (E1 or E2), NAMED after the ONE observation that produced it
 *   (`idDaTarefaDeAgendamentoAmazon`, step-15 plan §3 decision 3): the NF-e
 *   dispatch's own task id, or the pedido and the import read's order clock.
 *   A redelivery of the SAME observation (an NF-e queue retry, the same read
 *   imported again) meets Cloud Tasks' own refusal of a held id and answers
 *   `ja-enfileirada` — already durable (rule 7 tier 0), never an error. A NEW
 *   observation always lands under a new name, whatever an earlier task for
 *   the same pedido concluded: Cloud Tasks refuses a name for about an hour
 *   after its task RAN, so a name derived from the pedido alone would swallow
 *   every later observation for that hour. An E1 observation with no NF-e task
 *   id (never in a real dispatch: the queue always hands one in) enqueues
 *   UNNAMED rather than under a name every such enqueue would share.
 * - {@link AgendadorAgendamentoAmazon.enfileirar} — the scheduling task's own
 *   re-enqueues (the `espera` and `pausa` rungs): UNNAMED, because a tombstone
 *   would refuse the next rung.
 *
 * Neither sends a `uri` (under the emulator a supplied one would ship the task
 * to the deployed function). The payload is re-checked against
 * `tarefaAgendamentoAmazonSchema` before it leaves (a payload literal built
 * outside the builders is a bug, refused here as a `ZodError`, nothing
 * enqueued), and an entry's observation must be the payload's own (its origin
 * and, for an import, its pedido): a mismatch is a `RangeError`, nothing
 * enqueued.
 *
 * ## What a rejection MEANS
 *
 * - {@link AmazonAgendamentoTarefasDesligadasError} — the queue valve
 *   (`AMAZON_TASKS_DISABLED=1`) is closed: nothing enqueued, the queue never
 *   resolved. There is no scheduling sweep behind it: the entries log one
 *   WARNING and the checkout print schedules instead.
 * - `AmazonTarefasTransitoriasError` — Cloud Tasks hiccupped, named by
 *   `core/filaTarefas.ts`'s shared classifier.
 * - {@link AmazonAgendamentoRegiaoDaFilaInvalidaError} — the root's region is
 *   outside the queue-path grammar (a broken deploy, named).
 * - anything else, rethrown EXACTLY as it was thrown (a broken deploy, a root's
 *   `MissingRegionError`, a coding bug).
 */
import {
  ehTarefaJaExistenteAmazon,
  enfileirarNomeandoFalhaTransitoriaAmazon,
  regiaoDaFilaValidaAmazon,
} from '../core/filaTarefas';
import {
  FILA_AGENDAMENTO_AMAZON,
  ORIGEM_AGENDAMENTO_AMAZON,
  type ObservacaoAgendamentoAmazon,
  type TarefaAgendamentoAmazon,
  idDaTarefaDeAgendamentoAmazon,
  tarefaAgendamentoAmazonSchema,
} from './tarefaAgendamento';

/** What one enqueue carries besides the payload: a delay, and (an entry only) a task id. */
export interface OpcoesDaTarefaAgendamentoAmazon {
  readonly scheduleDelaySeconds?: number;
  readonly id?: string;
}

/**
 * The transport, as a root binds it — structurally, the Admin SDK's
 * `TaskQueue<TarefaAgendamentoAmazon>`, of which only `enqueue(data, opts?)` is
 * used.
 */
export interface FilaAgendamentoAmazon {
  enqueue(
    payload: TarefaAgendamentoAmazon,
    opcoes?: OpcoesDaTarefaAgendamentoAmazon,
  ): Promise<void>;
}

/**
 * The observation an ENTRY hands in: {@link ObservacaoAgendamentoAmazon}, except
 * that E1's NF-e task id may be `null` (the queue's `req.id` is optional in the
 * SDK's type) — an enqueue that then goes UNNAMED (module header).
 */
export type ObservacaoDaEntradaAgendamentoAmazon =
  | {
      readonly origem: typeof ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe;
      readonly idTarefaNfe: string | null;
    }
  | Extract<
      ObservacaoAgendamentoAmazon,
      { readonly origem: typeof ORIGEM_AGENDAMENTO_AMAZON.importacao }
    >;

/** What an entry's enqueue did. */
export type ResultadoEnfileiramentoAgendamentoAmazon = 'enfileirada' | 'ja-enfileirada';

/** The enqueue seam the two entries and the task's own re-enqueues depend on. */
export interface AgendadorAgendamentoAmazon {
  /**
   * An ENTRY's enqueue (E1, E2), named after its observation (module header),
   * after `atrasoS` seconds when given and positive.
   */
  enfileirarEntrada(
    payload: TarefaAgendamentoAmazon,
    observacao: ObservacaoDaEntradaAgendamentoAmazon,
    atrasoS?: number,
  ): Promise<ResultadoEnfileiramentoAgendamentoAmazon>;
  /** The task's own re-enqueues: UNNAMED, after `atrasoS` seconds when given and positive. */
  enfileirar(payload: TarefaAgendamentoAmazon, atrasoS?: number): Promise<void>;
}

export interface OpcoesAgendadorAgendamentoAmazon {
  /**
   * The queue, resolved PER ENQUEUE and only when the valve is open: a root's
   * region guard then rejects that enqueue (rethrown untouched) instead of
   * failing a module load, and a closed valve never touches the SDK at all.
   */
  readonly fila: () => FilaAgendamentoAmazon;
  /** The queue valve, as the root read it (exactly `'1'` closes it). */
  readonly desligado: boolean;
}

/**
 * The region-qualified path of the scheduling queue. MANDATORY: without the
 * `locations/{region}/functions/` prefix the Admin SDK targets its own default
 * region and the task is silently dropped (#1108).
 *
 * @throws {AmazonAgendamentoRegiaoDaFilaInvalidaError} for a region
 *   `regiaoDaFilaValidaAmazon` refuses — a `/` would make it another path, and
 *   an empty one a well-formed path to nowhere.
 */
export function caminhoDaFilaAgendamentoAmazon(regiao: string): string {
  if (!regiaoDaFilaValidaAmazon(regiao)) throw new AmazonAgendamentoRegiaoDaFilaInvalidaError();
  return `locations/${regiao}/functions/${FILA_AGENDAMENTO_AMAZON}`;
}

/**
 * The scheduling queue's region is outside the grammar a queue path accepts: a
 * DEPLOY-shaped refusal, like a root's `MissingRegionError`, raised per enqueue
 * (the queue is resolved lazily). NAMED so the entries can answer it as the
 * deterministic refusal it is (a retry would only repeat it). A `TypeError`
 * still: a malformed input, nothing transient.
 */
export class AmazonAgendamentoRegiaoDaFilaInvalidaError extends TypeError {
  constructor() {
    super('caminhoDaFilaAgendamentoAmazon: região fora da gramática (minúsculas, dígitos, -)');
    this.name = 'AmazonAgendamentoRegiaoDaFilaInvalidaError';
  }
}

/**
 * The queue valve is closed (`AMAZON_TASKS_DISABLED=1`): nothing was enqueued.
 * No sweep drains the scheduling queue: the checkout print schedules instead.
 *
 * Its OWN class, never the reads queue's or the NF-e queue's: each promises a
 * different remedy, and a catch written for one must never take another.
 */
export class AmazonAgendamentoTarefasDesligadasError extends Error {
  constructor() {
    super(
      'AMAZON_TASKS_DISABLED=1 — a fila de agendamento da coleta está desligada; ' +
        'nada foi enfileirado e não há varredura de agendamento (a impressão da etiqueta agenda)',
    );
    this.name = 'AmazonAgendamentoTarefasDesligadasError';
  }
}

/**
 * A delay as the transport takes it: `undefined` or `0` ⇒ none, a positive
 * whole number of seconds ⇒ `scheduleDelaySeconds`.
 *
 * @throws {RangeError} a negative, fractional or non-finite delay (a bug: the
 *   ladders are whole seconds).
 */
function atrasoValido(atrasoS: number | undefined): number | undefined {
  if (atrasoS === undefined) return undefined;
  if (!Number.isSafeInteger(atrasoS) || atrasoS < 0) {
    throw new RangeError('agendadorAgendamento.ts: atraso fora de segundos inteiros não negativos');
  }
  return atrasoS === 0 ? undefined : atrasoS;
}

/**
 * The task id of an entry's observation, or `null` for an E1 observation with
 * no NF-e task id (module header).
 *
 * @throws {RangeError} an observation that is not the payload's own: another
 *   origin, or (an import) another pedido — a bug, nothing enqueued.
 */
function idDaEntrada(
  tarefa: TarefaAgendamentoAmazon,
  observacao: ObservacaoDaEntradaAgendamentoAmazon,
): string | null {
  if (observacao.origem !== tarefa.origem) {
    throw new RangeError('agendadorAgendamento.ts: a observação é de outra origem que a tarefa');
  }
  if (observacao.origem === ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe) {
    if (observacao.idTarefaNfe === null) return null;
    return idDaTarefaDeAgendamentoAmazon({
      origem: observacao.origem,
      idTarefaNfe: observacao.idTarefaNfe,
    });
  }
  if (observacao.pedidoId !== tarefa.pedidoId) {
    throw new RangeError('agendadorAgendamento.ts: a observação é de outro pedido que a tarefa');
  }
  return idDaTarefaDeAgendamentoAmazon(observacao);
}

/** The transport's options: the id when named, the delay when positive; none at all otherwise. */
function opcoesDaTarefa(
  id: string | null,
  atrasoS: number | undefined,
): OpcoesDaTarefaAgendamentoAmazon | undefined {
  if (id === null && atrasoS === undefined) return undefined;
  return {
    ...(id === null ? {} : { id }),
    ...(atrasoS === undefined ? {} : { scheduleDelaySeconds: atrasoS }),
  };
}

/**
 * The producer: with the valve closed, every enqueue rejects with
 * {@link AmazonAgendamentoTarefasDesligadasError} and the queue is never
 * resolved; otherwise each enqueue resolves the queue and runs through the
 * shared transient naming (module header).
 */
export function criarAgendadorAgendamentoAmazon(
  opcoes: OpcoesAgendadorAgendamentoAmazon,
): AgendadorAgendamentoAmazon {
  return {
    async enfileirarEntrada(payload, observacao, atrasoS) {
      const tarefa = tarefaAgendamentoAmazonSchema.parse(payload);
      const id = idDaEntrada(tarefa, observacao);
      const extras = opcoesDaTarefa(id, atrasoValido(atrasoS));
      if (opcoes.desligado) throw new AmazonAgendamentoTarefasDesligadasError();
      let jaExiste = false;
      await enfileirarNomeandoFalhaTransitoriaAmazon(async () => {
        try {
          await (extras === undefined
            ? opcoes.fila().enqueue(tarefa)
            : opcoes.fila().enqueue(tarefa, extras));
        } catch (err) {
          // Read BEFORE the transient naming, which would call this 409 a
          // hiccup: Cloud Tasks already holds this observation's task (tier
          // 0). Only a NAMED enqueue can meet it; an unnamed one's 409 is an
          // ABORTED, a transient.
          if (id !== null && ehTarefaJaExistenteAmazon(err)) {
            jaExiste = true;
            return;
          }
          throw err;
        }
      });
      return jaExiste ? 'ja-enfileirada' : 'enfileirada';
    },

    async enfileirar(payload, atrasoS) {
      const tarefa = tarefaAgendamentoAmazonSchema.parse(payload);
      const extras = opcoesDaTarefa(null, atrasoValido(atrasoS));
      if (opcoes.desligado) throw new AmazonAgendamentoTarefasDesligadasError();
      await enfileirarNomeandoFalhaTransitoriaAmazon(() =>
        extras === undefined
          ? opcoes.fila().enqueue(tarefa)
          : opcoes.fila().enqueue(tarefa, extras),
      );
    },
  };
}
