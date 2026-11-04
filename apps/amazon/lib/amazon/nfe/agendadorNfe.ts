/**
 * The NF-e queue's PRODUCER, pure (step 14, PR 14-c): what an enqueue onto
 * `processAmazonNfeUpload` ({@link FILA_NFE_AMAZON}) means, with the transport
 * handed in.
 *
 * The queue itself is bound by a COMPOSITION ROOT, never here: the functions
 * codebase's `functions/src/agendadorNfe.ts` (the trigger and the handler's
 * self re-enqueue) — and, in 14-d, the App Hosting root for the re-drive
 * route. Each root resolves the region, builds the path with
 * {@link caminhoDaFilaNfeAmazon}, reads the queue valve and passes both in as
 * {@link OpcoesAgendadorNfeAmazon}. Nothing here reads the process environment
 * or imports the Cloud Tasks SDK: the transport is STRUCTURAL
 * ({@link FilaNfeAmazon}), and the SDK knowledge is `core/filaTarefas.ts`'s.
 *
 * ## Two entry points, and only ONE names its task
 *
 * - {@link AgendadorNfeAmazon.enfileirarDoGatilho} — the trigger's FIRST
 *   enqueue of an upload, NAMED after the CloudEvent:
 *   `id = sha256Hex(eventId)` ({@link idDaTarefaDoGatilhoNfeAmazon}).
 *   Eventarc is at-least-once, and a redelivery carries the SAME event id, so
 *   the second enqueue meets Cloud Tasks' own refusal of a held id and answers
 *   `ja-enfileirada` — already durable (rule 7 tier 0), never an error. The
 *   hash keeps the id inside Cloud Tasks' grammar (64 lowercase hex) whatever
 *   the event id holds, and carries no business value. That holds while Cloud
 *   Tasks remembers the id (about an hour after the task ran); a later
 *   redelivery converges through the task's status-first read (step-14 plan
 *   §5 risk 2).
 * - {@link AgendadorNfeAmazon.enfileirar} — everything else (the chain's
 *   re-enqueues, the 14-d re-drive): UNNAMED, the app's rule (step-14 plan §3
 *   decision 10). A Cloud Tasks tombstone on a name derived from the pedido or
 *   the rung would refuse the next rung or a legitimate human re-drive.
 *
 * Neither sends a `uri` (under the emulator a supplied one would ship the task
 * to the deployed function). The payload is re-checked against
 * `tarefaNfeAmazonSchema` before it leaves (a payload literal built outside the
 * builders is a bug, refused here as a `ZodError`, nothing enqueued).
 *
 * ## What a rejection MEANS
 *
 * - {@link AmazonNfeTarefasDesligadasError} — the queue valve
 *   (`AMAZON_TASKS_DISABLED=1`) is closed: nothing enqueued, the queue never
 *   resolved. There is NO NF-e sweep behind it: the caller (the trigger, or a
 *   task whose next chain step it was) raises the aviso `tarefas-desligadas`,
 *   and the aviso list is the re-drive worklist.
 * - `AmazonTarefasTransitoriasError` — Cloud Tasks hiccupped, named by
 *   `core/filaTarefas.ts`'s shared classifier.
 * - {@link AmazonNfeRegiaoDaFilaInvalidaError} — the root's region is outside
 *   the queue-path grammar (a broken deploy, named).
 * - anything else, rethrown EXACTLY as it was thrown (a broken deploy, a root's
 *   `MissingRegionError`, a coding bug).
 *
 * ⚠️ On the NF-e trigger's import closure (`estrutura.test.ts`, pinned file by
 * file, D11 by construction): this module may reach no context, conta read,
 * valve or SP-API value — it imports the shared helpers, the payload contract
 * and the digest, and nothing else.
 */
import { sha256Hex } from '@delfrance/data/admin';

import {
  ehTarefaJaExistenteAmazon,
  enfileirarNomeandoFalhaTransitoriaAmazon,
  regiaoDaFilaValidaAmazon,
} from '../core/filaTarefas';
import { FILA_NFE_AMAZON, type TarefaNfeAmazon, tarefaNfeAmazonSchema } from './tarefaNfe';

/** What one enqueue carries besides the payload: a delay, or (the trigger only) a task id. */
export interface OpcoesDaTarefaNfeAmazon {
  readonly scheduleDelaySeconds?: number;
  readonly id?: string;
}

/**
 * The transport, as a root binds it — structurally, the Admin SDK's
 * `TaskQueue<TarefaNfeAmazon>`, of which only `enqueue(data, opts?)` is used.
 */
export interface FilaNfeAmazon {
  enqueue(payload: TarefaNfeAmazon, opcoes?: OpcoesDaTarefaNfeAmazon): Promise<void>;
}

/** What the trigger's named enqueue did. */
export type ResultadoEnfileiramentoNfeAmazon = 'enfileirada' | 'ja-enfileirada';

/** The enqueue seam the trigger, the handler and the route depend on. */
export interface AgendadorNfeAmazon {
  /** The trigger's first enqueue, named after the CloudEvent (module header). */
  enfileirarDoGatilho(
    payload: TarefaNfeAmazon,
    eventId: string,
  ): Promise<ResultadoEnfileiramentoNfeAmazon>;
  /** Every other enqueue: UNNAMED, after `atrasoS` seconds when given and positive. */
  enfileirar(payload: TarefaNfeAmazon, atrasoS?: number): Promise<void>;
}

export interface OpcoesAgendadorNfeAmazon {
  /**
   * The queue, resolved PER ENQUEUE and only when the valve is open: a root's
   * region guard then rejects that enqueue (rethrown untouched) instead of
   * failing a module load, and a closed valve never touches the SDK at all.
   */
  readonly fila: () => FilaNfeAmazon;
  /** The queue valve, as the root read it (exactly `'1'` closes it). */
  readonly desligado: boolean;
}

/**
 * The region-qualified path of the NF-e queue. MANDATORY: without the
 * `locations/{region}/functions/` prefix the Admin SDK targets its own default
 * region and the task is silently dropped (#1108).
 *
 * @throws {AmazonNfeRegiaoDaFilaInvalidaError} for a region
 *   `regiaoDaFilaValidaAmazon` refuses — a `/` would make it another path, and
 *   an empty one a well-formed path to nowhere.
 */
export function caminhoDaFilaNfeAmazon(regiao: string): string {
  if (!regiaoDaFilaValidaAmazon(regiao)) throw new AmazonNfeRegiaoDaFilaInvalidaError();
  return `locations/${regiao}/functions/${FILA_NFE_AMAZON}`;
}

/**
 * The NF-e queue's region is outside the grammar a queue path accepts: a
 * DEPLOY-shaped refusal, like a root's `MissingRegionError`, raised per enqueue
 * (the queue is resolved lazily). NAMED so the task's no-throw boundary can
 * contain it after a submit — a plain `TypeError` there is an unnamed bug that
 * crosses the boundary, and the queue's retry would read status inside the
 * read-after-write lag and submit again. A `TypeError` still: a malformed
 * input, nothing transient.
 */
export class AmazonNfeRegiaoDaFilaInvalidaError extends TypeError {
  constructor() {
    super('caminhoDaFilaNfeAmazon: região fora da gramática (minúsculas, dígitos, -)');
    this.name = 'AmazonNfeRegiaoDaFilaInvalidaError';
  }
}

/**
 * The trigger's task id: the sha256 of the CloudEvent id, lowercase hex — the
 * same input always yields the same id, and two events never share one.
 *
 * @throws {RangeError} an empty event id (a CloudEvent always carries one; an
 *   empty one would name every such enqueue alike).
 */
export function idDaTarefaDoGatilhoNfeAmazon(eventId: string): string {
  if (eventId === '') {
    throw new RangeError('idDaTarefaDoGatilhoNfeAmazon: o evento não tem id');
  }
  return sha256Hex(eventId);
}

/**
 * The queue valve is closed (`AMAZON_TASKS_DISABLED=1`): nothing was enqueued.
 * No sweep drains the NF-e queue, so the caller raises `tarefas-desligadas`.
 *
 * A plain `Error`, never the reads queue's `AmazonTarefasDesligadasError`: that
 * one's message promises a sweep this queue does not have, and the trigger
 * catches THIS class alone.
 */
export class AmazonNfeTarefasDesligadasError extends Error {
  constructor() {
    super(
      'AMAZON_TASKS_DISABLED=1 — a fila de envio de NF-e está desligada; ' +
        'nada foi enfileirado e não há varredura de NF-e (o aviso é a lista de reenvio)',
    );
    this.name = 'AmazonNfeTarefasDesligadasError';
  }
}

/**
 * A delay as the transport takes it: `undefined` or `0` ⇒ no option at all (the
 * payload ALONE), a positive whole number of seconds ⇒ `scheduleDelaySeconds`.
 *
 * @throws {RangeError} a negative, fractional or non-finite delay (a bug: the
 *   ladders are whole seconds).
 */
function opcoesDeAtraso(atrasoS: number | undefined): OpcoesDaTarefaNfeAmazon | undefined {
  if (atrasoS === undefined) return undefined;
  if (!Number.isSafeInteger(atrasoS) || atrasoS < 0) {
    throw new RangeError('agendadorNfe.ts: atraso fora de segundos inteiros não negativos');
  }
  return atrasoS === 0 ? undefined : { scheduleDelaySeconds: atrasoS };
}

/**
 * The producer: with the valve closed, every enqueue rejects with
 * {@link AmazonNfeTarefasDesligadasError} and the queue is never resolved;
 * otherwise each enqueue resolves the queue and runs through the shared
 * transient naming (module header).
 */
export function criarAgendadorNfeAmazon(opcoes: OpcoesAgendadorNfeAmazon): AgendadorNfeAmazon {
  return {
    async enfileirarDoGatilho(payload, eventId) {
      const tarefa = tarefaNfeAmazonSchema.parse(payload);
      const id = idDaTarefaDoGatilhoNfeAmazon(eventId);
      if (opcoes.desligado) throw new AmazonNfeTarefasDesligadasError();
      let jaExiste = false;
      await enfileirarNomeandoFalhaTransitoriaAmazon(async () => {
        try {
          await opcoes.fila().enqueue(tarefa, { id });
        } catch (err) {
          // Read BEFORE the transient naming, which would call this 409 a
          // hiccup: Cloud Tasks already holds this event's task (tier 0).
          if (ehTarefaJaExistenteAmazon(err)) {
            jaExiste = true;
            return;
          }
          throw err;
        }
      });
      return jaExiste ? 'ja-enfileirada' : 'enfileirada';
    },

    async enfileirar(payload, atrasoS) {
      const tarefa = tarefaNfeAmazonSchema.parse(payload);
      const extras = opcoesDeAtraso(atrasoS);
      if (opcoes.desligado) throw new AmazonNfeTarefasDesligadasError();
      await enfileirarNomeandoFalhaTransitoriaAmazon(() =>
        extras === undefined
          ? opcoes.fila().enqueue(tarefa)
          : opcoes.fila().enqueue(tarefa, extras),
      );
    },
  };
}
