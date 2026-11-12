/**
 * The jobs queue's PRODUCER, pure (step 12a, PR 12-c): what an enqueue onto
 * `processAmazonListingsJob` ({@link FILA_LOTES_AMAZON}) means, with the
 * transport handed in. Modelled on the NF-e and scheduling producers
 * (`nfe/agendadorNfe.ts`, `agendamento/agendadorAgendamento.ts`), with ONE
 * entry point for the four feed tasks, NAMED or not by its caller.
 *
 * The queue itself is bound by a COMPOSITION ROOT, never here: the functions
 * codebase's `functions/src/agendadorEstoque.ts` (the feed handlers' own
 * enqueues) and the App Hosting `lib/firebase/filaLeitura.ts` (the receiver's
 * `FEED_PROCESSING_FINISHED` wake-up). The root resolves the region, builds the
 * path with {@link caminhoDaFilaLotesAmazon}, reads the queue valve and passes
 * both in as {@link OpcoesAgendadorLotesAmazon}. Nothing here reads the process
 * environment or imports the Cloud Tasks SDK: the transport is STRUCTURAL
 * ({@link FilaLotesAmazon}), and the SDK knowledge is `core/filaTarefas.ts`'s.
 * This module imports nothing else of `feeds/` but the payload contract
 * (`./tarefaLote`), so the receiver's closure reaches no handler.
 *
 * ## Named or unnamed — the caller's `nome`
 *
 * A task NAME is a Cloud Tasks id: a create whose id the queue already holds is
 * refused for about an hour after that task RAN, so a name makes an enqueue
 * idempotent (rule 7 tier 0) and a wrong name swallows a later legitimate one.
 * Every name the feed core mints is a `sha256Hex` digest of a preimage that
 * carries the conta (`tarefaLote.ts`), and this producer takes exactly that
 * shape: a `nome` that is not 64 lowercase hex digits is a `RangeError`,
 * nothing enqueued, so no raw id (a seller id, a SKU) ever becomes a task id
 * visible in the console.
 *
 *  - NAMED, `ja-enfileirada` on Cloud Tasks' own refusal of a held id: the
 *    notification wake-up, every poll rung and the adoption rung
 *    (`feed-resultado`), every recovery (`feed-recuperar`, the `vez` one
 *    included), the uncertain wait (`feed-incerto`), a send minted by its
 *    producer's identity (`feed-enviar`).
 *  - UNNAMED: the waits — a 429's re-enqueue, the submission floor's remainder,
 *    the uncertain wait's early re-enqueue, a turned-away batch's 300-s wait —
 *    because a tombstone would refuse the next one. Only `feed-enviar` and
 *    `feed-incerto` have unnamed enqueues: a `feed-resultado` or a
 *    `feed-recuperar` without a `nome` is a `RangeError` (an unnamed rung or
 *    recovery would fork its chain on the queue's own retries).
 *
 * An unnamed enqueue's 409 is never "already there": Cloud Tasks can answer
 * it only ABORTED, a transient (`core/filaTarefas.ts`).
 *
 * ## Delays: WHOLE seconds
 *
 * `atrasoS` is handed to Cloud Tasks as `scheduleDelaySeconds`: `undefined` or
 * `0` ⇒ none; a negative, fractional or non-finite value is a `RangeError`,
 * nothing enqueued. So is a delay past
 * {@link MAX_ATRASO_LOTE_S} (one day, twice the longest wait the core asks
 * for, the 12-h uncertain wait): a delay in that range is a value handed over
 * in MILLISECONDS, which would park the task for months.
 *
 * Neither path sends a `uri` (under the emulator a supplied one would ship the
 * task to the deployed function). The payload is re-checked against
 * `tarefaLoteAmazonSchema` before it leaves (a literal built outside the
 * builders is a bug, refused here as a `ZodError`, nothing enqueued).
 *
 * ## What a rejection MEANS
 *
 * - {@link AmazonLotesTarefasDesligadasError} — the queue valve
 *   (`AMAZON_TASKS_DISABLED=1`) is closed: nothing enqueued, the queue never
 *   resolved. There is no sweep behind it: a lost poll rung leaves its feed to
 *   the daily backstop, a lost wake-up to the poll chain.
 * - `AmazonTarefasTransitoriasError` — Cloud Tasks hiccupped, named by
 *   `core/filaTarefas.ts`'s shared classifier.
 * - {@link AmazonLotesRegiaoDaFilaInvalidaError} — the root's region is outside
 *   the queue-path grammar (a broken deploy, named).
 * - anything else, rethrown EXACTLY as it was thrown (a broken deploy, a root's
 *   `MissingRegionError`, a coding bug).
 */
import {
  ehTarefaJaExistenteAmazon,
  enfileirarNomeandoFalhaTransitoriaAmazon,
  regiaoDaFilaValidaAmazon,
} from '../core/filaTarefas';
import {
  TIPO_TAREFA_LOTE_AMAZON,
  type TarefaLoteAmazon,
  tarefaLoteAmazonSchema,
} from './tarefaLote';

/** The jobs queue's function name: the export `functions/src/index.ts` asserts at load. */
export const FILA_LOTES_AMAZON = 'processAmazonListingsJob';

/**
 * The longest delay this producer accepts, in seconds (one day): twice the
 * longest wait the feed core asks for, the uncertain wait of 12 h. A larger
 * value is a delay handed over in milliseconds (module header).
 */
export const MAX_ATRASO_LOTE_S = 86_400;

/** A task name as the feed core mints it: a `sha256Hex` digest. */
const NOME_DE_TAREFA_LOTE = /^[0-9a-f]{64}$/;

/** What one enqueue carries besides the payload: a delay, and a task id when named. */
export interface OpcoesDaTarefaLoteAmazon {
  readonly scheduleDelaySeconds?: number;
  readonly id?: string;
}

/**
 * The transport, as a root binds it — structurally, the Admin SDK's
 * `TaskQueue<TarefaLoteAmazon>`, of which only `enqueue(data, opts?)` is used.
 */
export interface FilaLotesAmazon {
  enqueue(payload: TarefaLoteAmazon, opcoes?: OpcoesDaTarefaLoteAmazon): Promise<void>;
}

/** What one enqueue asks for: a name (module header) and a delay in WHOLE seconds. */
export interface PedidoDeEnfileiramentoLoteAmazon {
  readonly nome?: string;
  readonly atrasoS?: number;
}

/** What an enqueue did. `ja-enfileirada` only for a NAMED one. */
export type ResultadoEnfileiramentoLoteAmazon = 'enfileirada' | 'ja-enfileirada';

/** The enqueue seam every feed handler and the receiver's wake-up depend on. */
export interface AgendadorLotesAmazon {
  enfileirarLote(
    tarefa: TarefaLoteAmazon,
    pedido?: PedidoDeEnfileiramentoLoteAmazon,
  ): Promise<ResultadoEnfileiramentoLoteAmazon>;
}

export interface OpcoesAgendadorLotesAmazon {
  /**
   * The queue, resolved PER ENQUEUE and only when the valve is open: a root's
   * region guard then rejects that enqueue (rethrown untouched) instead of
   * failing a module load, and a closed valve never touches the SDK at all.
   */
  readonly fila: () => FilaLotesAmazon;
  /** The queue valve, as the root read it (exactly `'1'` closes it). */
  readonly desligado: boolean;
}

/**
 * The region-qualified path of the jobs queue. MANDATORY: without the
 * `locations/{region}/functions/` prefix the Admin SDK targets its own default
 * region and the task is silently dropped (#1108).
 *
 * @throws {AmazonLotesRegiaoDaFilaInvalidaError} for a region
 *   `regiaoDaFilaValidaAmazon` refuses — a `/` would make it another path, and
 *   an empty one a well-formed path to nowhere.
 */
export function caminhoDaFilaLotesAmazon(regiao: string): string {
  if (!regiaoDaFilaValidaAmazon(regiao)) throw new AmazonLotesRegiaoDaFilaInvalidaError();
  return `locations/${regiao}/functions/${FILA_LOTES_AMAZON}`;
}

/**
 * The jobs queue's region is outside the grammar a queue path accepts: a
 * DEPLOY-shaped refusal, raised per enqueue (the queue is resolved lazily). A
 * `TypeError` still: a malformed input, nothing transient.
 */
export class AmazonLotesRegiaoDaFilaInvalidaError extends TypeError {
  constructor() {
    super('caminhoDaFilaLotesAmazon: região fora da gramática (minúsculas, dígitos, -)');
    this.name = 'AmazonLotesRegiaoDaFilaInvalidaError';
  }
}

/**
 * The queue valve is closed (`AMAZON_TASKS_DISABLED=1`): nothing was enqueued.
 *
 * Its OWN class, never another queue's: each promises a different remedy, and a
 * catch written for one must never take another.
 */
export class AmazonLotesTarefasDesligadasError extends Error {
  constructor() {
    super(
      'AMAZON_TASKS_DISABLED=1 — a fila de tarefas de feed está desligada; ' +
        'nada foi enfileirado (a cadeia de consulta e o backstop diário retomam o feed)',
    );
    this.name = 'AmazonLotesTarefasDesligadasError';
  }
}

/**
 * A delay as the transport takes it (module header): `undefined` or `0` ⇒
 * none, a whole number of seconds up to {@link MAX_ATRASO_LOTE_S} ⇒
 * `scheduleDelaySeconds`.
 *
 * @throws {RangeError} a negative, fractional, non-finite or ms-sized delay.
 */
function atrasoValido(atrasoS: number | undefined): number | undefined {
  if (atrasoS === undefined) return undefined;
  if (!Number.isSafeInteger(atrasoS) || atrasoS < 0) {
    throw new RangeError('agendadorLotes.ts: atraso fora de segundos inteiros não negativos');
  }
  if (atrasoS > MAX_ATRASO_LOTE_S) {
    throw new RangeError(
      'agendadorLotes.ts: atraso acima de um dia (milissegundos no lugar de segundos?)',
    );
  }
  return atrasoS === 0 ? undefined : atrasoS;
}

/**
 * The task id of one enqueue, or `null` when unnamed (module header).
 *
 * @throws {RangeError} a name that is not a digest, or a `feed-resultado` /
 *   `feed-recuperar` without one.
 */
function idDoPedido(tarefa: TarefaLoteAmazon, nome: string | undefined): string | null {
  if (nome === undefined) {
    if (
      tarefa.tipo === TIPO_TAREFA_LOTE_AMAZON.resultado ||
      tarefa.tipo === TIPO_TAREFA_LOTE_AMAZON.recuperar
    ) {
      throw new RangeError(`agendadorLotes.ts: ${tarefa.tipo} sempre leva nome`);
    }
    return null;
  }
  if (!NOME_DE_TAREFA_LOTE.test(nome)) {
    throw new RangeError('agendadorLotes.ts: nome de tarefa fora da gramática (sha256 hex)');
  }
  return nome;
}

/** The transport's options: the id when named, the delay when positive; none at all otherwise. */
function opcoesDaTarefa(
  id: string | null,
  atrasoS: number | undefined,
): OpcoesDaTarefaLoteAmazon | undefined {
  if (id === null && atrasoS === undefined) return undefined;
  return {
    ...(id === null ? {} : { id }),
    ...(atrasoS === undefined ? {} : { scheduleDelaySeconds: atrasoS }),
  };
}

/**
 * The producer: with the valve closed, every enqueue rejects with
 * {@link AmazonLotesTarefasDesligadasError} and the queue is never resolved;
 * otherwise each enqueue resolves the queue and runs through the shared
 * transient naming (module header).
 */
export function criarAgendadorLotesAmazon(
  opcoes: OpcoesAgendadorLotesAmazon,
): AgendadorLotesAmazon {
  return {
    async enfileirarLote(payload, pedido = {}) {
      const tarefa = tarefaLoteAmazonSchema.parse(payload);
      const id = idDoPedido(tarefa, pedido.nome);
      const extras = opcoesDaTarefa(id, atrasoValido(pedido.atrasoS));
      if (opcoes.desligado) throw new AmazonLotesTarefasDesligadasError();
      let jaExiste = false;
      await enfileirarNomeandoFalhaTransitoriaAmazon(async () => {
        try {
          await (extras === undefined
            ? opcoes.fila().enqueue(tarefa)
            : opcoes.fila().enqueue(tarefa, extras));
        } catch (err) {
          // Read BEFORE the transient naming, which would call this 409 a
          // hiccup: Cloud Tasks already holds this name (tier 0). Only a NAMED
          // enqueue can meet it; an unnamed one's 409 is an ABORTED, a transient.
          if (id !== null && ehTarefaJaExistenteAmazon(err)) {
            jaExiste = true;
            return;
          }
          throw err;
        }
      });
      return jaExiste ? 'ja-enfileirada' : 'enfileirada';
    },
  };
}
