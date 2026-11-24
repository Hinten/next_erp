/**
 * The stock queue's PRODUCER, pure (step 12, PR 12-e1): what an enqueue onto
 * `processAmazonStockPatch` ({@link FILA_ESTOQUE_AMAZON}) means, with the
 * transport handed in. Modelled on the jobs and scheduling producers
 * (`feeds/agendadorLotes.ts`, `agendamento/agendadorAgendamento.ts`).
 *
 * The queue itself is bound by a COMPOSITION ROOT, never here: the functions
 * codebase's `functions/src/agendadorEstoque.ts`. The root resolves the region,
 * builds the path with {@link caminhoDaFilaEstoqueAmazon}, reads the queue valve
 * and passes both in as {@link OpcoesProdutorEstoqueAmazon}. Nothing here reads
 * the process environment or imports the Cloud Tasks SDK: the transport is
 * STRUCTURAL ({@link FilaEstoqueAmazon}), and the SDK knowledge is
 * `core/filaTarefas.ts`'s. The basename differs from that root's on purpose:
 * two `agendadorEstoque.ts` files, one of them a root, would be one import typo
 * apart.
 *
 * Since step 13 (PR 13-b) it binds the listings flows' shared producer core
 * (`listings/produtorListing.ts`: the one enqueue, the whole-second delays and
 * the batch) to this queue: its payload contract, its task names, its delay
 * bound and its valve class. What stays here is the stock queue's own: the
 * path, the two classes, the read-back and the pause.
 *
 * ## Four entries, and which of them NAME their task
 *
 * A task NAME is a Cloud Tasks id: a create whose id the queue already holds is
 * refused for about an hour after that task RAN, so a name makes an enqueue
 * idempotent (rule 7 tier 0) and a wrong name swallows a later legitimate one.
 *
 *  - {@link ProdutorEstoqueAmazon.enfileirar} and
 *    {@link ProdutorEstoqueAmazon.enfileirarLote}: NAMED by the payload's own
 *    `nomeDaTarefaEstoque` (the origem, the conta, the reference and the SKU),
 *    so the same observation minted twice — the tick's overlap, a re-run tick,
 *    a recovery seeing it again — is one task, and Cloud Tasks' refusal of a
 *    held id answers `ja-enfileirada` (already durable), never an error. A
 *    batch runs at most {@link LARGURA_LOTE_ESTOQUE_AMAZON} enqueues at once.
 *  - {@link ProdutorEstoqueAmazon.enfileirarVerificacao}: the ONE read-back of
 *    an accepted patch, `origem: 'verificacao'`, NAMED after Amazon's
 *    `submissionId` (one read-back per submission, whatever retries the patch
 *    task makes) and delayed {@link ATRASO_VERIFICACAO_ESTOQUE_S}. It refuses a
 *    payload whose origem earns no read-back (`precisaVerificacao`): a
 *    read-back never chains a second one, and a reconcile's patch is read back
 *    by the next reconcile.
 *  - {@link ProdutorEstoqueAmazon.enfileirarPausa}: the re-enqueue of a task
 *    Amazon throttled (a 429), UNNAMED and delayed
 *    {@link ATRASO_PAUSA_ESTOQUE_S}: the task ends without spending a queue
 *    attempt, and a name would collide with the task that is still running
 *    under it. An unnamed enqueue's 409 is never "already there": Cloud Tasks
 *    can answer it only ABORTED, a transient (`core/filaTarefas.ts`).
 *
 * ## Delays: WHOLE seconds
 *
 * The shared core's whole-second rule (its header), bound to this queue's
 * bound {@link MAX_ATRASO_ESTOQUE_S}: one hour, three times the longest the
 * stock flow asks for, the reconcile's 20-minute send delay.
 *
 * No entry sends a `uri` (under the emulator a supplied one would ship the task
 * to the deployed function). Every payload is re-checked against
 * `tarefaEstoqueAmazonSchema` before it leaves (a literal built outside the
 * contract is a bug, refused as a `ZodError`, nothing enqueued). A payload
 * never carries a quantity: the task computes it when it runs.
 *
 * ## The batch
 *
 * {@link ProdutorEstoqueAmazon.enfileirarLote} is the shared core's batch (its
 * header: the width, the deadline hook, the earliest rejection) over this
 * producer's named enqueue, every payload checked before the first starts.
 * Because every payload is named, re-running a cut or failed batch enqueues
 * only what is missing.
 *
 * ## What a rejection MEANS
 *
 * - {@link AmazonEstoqueTarefasDesligadasError} — the queue valve
 *   (`AMAZON_TASKS_DISABLED=1`) is closed: nothing enqueued, the queue never
 *   resolved.
 * - `AmazonTarefasTransitoriasError` — Cloud Tasks hiccupped, named by
 *   `core/filaTarefas.ts`'s shared classifier.
 * - {@link AmazonEstoqueRegiaoDaFilaInvalidaError} — the root's region is
 *   outside the queue-path grammar (a broken deploy, named).
 * - anything else, rethrown EXACTLY as it was thrown (a broken deploy, a root's
 *   `MissingRegionError`, a coding bug).
 */
import { regiaoDaFilaValidaAmazon } from '../core/filaTarefas';
import {
  type FilaListingAmazon,
  LARGURA_LOTE_LISTING_AMAZON,
  type LimiteDeAtrasoListingAmazon,
  type OpcoesDaTarefaListingAmazon,
  type ResultadoEnfileiramentoListingAmazon,
  type ResultadoLoteListingAmazon,
  type VinculoFilaListingAmazon,
  atrasoDaFilaListingAmazon,
  enfileirarLoteListingAmazon,
  enfileirarNaFilaListingAmazon,
  opcoesDaTarefaListingAmazon,
} from '../listings/produtorListing';
import {
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type TarefaEstoqueAmazon,
  nomeDaTarefaEstoque,
  precisaVerificacao,
  tarefaEstoqueAmazonSchema,
} from './tarefaEstoque';

/** The stock queue's function name: the export `functions/src/index.ts` asserts at load. */
export const FILA_ESTOQUE_AMAZON = 'processAmazonStockPatch';

/** The most enqueues one batch keeps in flight (module header, "The batch"): the shared core's. */
export const LARGURA_LOTE_ESTOQUE_AMAZON = LARGURA_LOTE_LISTING_AMAZON;

/** The read-back's delay, in seconds: past the documented 0–15 min lag's typical 1–5 min. */
export const ATRASO_VERIFICACAO_ESTOQUE_S = 360;

/** A throttled task's re-enqueue delay, in seconds. */
export const ATRASO_PAUSA_ESTOQUE_S = 60;

/**
 * The longest delay this producer accepts, in seconds (one hour): three times
 * the longest the stock flow asks for, the reconcile's 20-minute send delay. A
 * larger value is a delay handed over in milliseconds (module header).
 */
export const MAX_ATRASO_ESTOQUE_S = 3_600;

/** What one enqueue carries besides the payload: a delay, and a task id when named. */
export type OpcoesDaTarefaEstoqueAmazon = OpcoesDaTarefaListingAmazon;

/**
 * The transport, as a root binds it — structurally, the Admin SDK's
 * `TaskQueue<TarefaEstoqueAmazon>`, of which only `enqueue(data, opts?)` is used.
 */
export type FilaEstoqueAmazon = FilaListingAmazon<TarefaEstoqueAmazon>;

/** What a NAMED enqueue did. */
export type ResultadoEnfileiramentoEstoqueAmazon = ResultadoEnfileiramentoListingAmazon;

/** What a batch did, counted (module header, "The batch"). */
export type ResultadoLoteEstoqueAmazon = ResultadoLoteListingAmazon;

/** A batch's options: one delay for every payload, and the producer's deadline. */
export interface OpcoesLoteEstoqueAmazon {
  readonly atrasoS?: number;
  /** Asked before STARTING each payload; `false` ⇒ nothing more is started. */
  readonly continuar?: () => boolean;
}

/** The enqueue seam the stock producers (the tick, a recovery, the reconcile, the task) depend on. */
export interface ProdutorEstoqueAmazon {
  /** ONE payload, named by its own fields, after `atrasoS` seconds when given and positive. */
  enfileirar(
    tarefa: TarefaEstoqueAmazon,
    atrasoS?: number,
  ): Promise<ResultadoEnfileiramentoEstoqueAmazon>;
  /** Many payloads, each named by its own fields, at most {@link LARGURA_LOTE_ESTOQUE_AMAZON} at once. */
  enfileirarLote(
    tarefas: readonly TarefaEstoqueAmazon[],
    opcoes?: OpcoesLoteEstoqueAmazon,
  ): Promise<ResultadoLoteEstoqueAmazon>;
  /** The read-back of `tarefa`'s accepted patch, named after `submissionId` (module header). */
  enfileirarVerificacao(
    tarefa: TarefaEstoqueAmazon,
    submissionId: string,
  ): Promise<ResultadoEnfileiramentoEstoqueAmazon>;
  /** `tarefa` again, UNNAMED, after {@link ATRASO_PAUSA_ESTOQUE_S} (a throttled task). */
  enfileirarPausa(tarefa: TarefaEstoqueAmazon): Promise<void>;
}

export interface OpcoesProdutorEstoqueAmazon {
  /**
   * The queue, resolved PER ENQUEUE and only when the valve is open: a root's
   * region guard then rejects that enqueue (rethrown untouched) instead of
   * failing a module load, and a closed valve never touches the SDK at all.
   */
  readonly fila: () => FilaEstoqueAmazon;
  /** The queue valve, as the root read it (exactly `'1'` closes it). */
  readonly desligado: boolean;
}

/**
 * The region-qualified path of the stock queue. MANDATORY: without the
 * `locations/{region}/functions/` prefix the Admin SDK targets its own default
 * region and the task is silently dropped (#1108).
 *
 * @throws {AmazonEstoqueRegiaoDaFilaInvalidaError} for a region
 *   `regiaoDaFilaValidaAmazon` refuses — a `/` would make it another path, and
 *   an empty one a well-formed path to nowhere.
 */
export function caminhoDaFilaEstoqueAmazon(regiao: string): string {
  if (!regiaoDaFilaValidaAmazon(regiao)) throw new AmazonEstoqueRegiaoDaFilaInvalidaError();
  return `locations/${regiao}/functions/${FILA_ESTOQUE_AMAZON}`;
}

/**
 * The stock queue's region is outside the grammar a queue path accepts: a
 * DEPLOY-shaped refusal, raised per enqueue (the queue is resolved lazily). A
 * `TypeError` still: a malformed input, nothing transient.
 */
export class AmazonEstoqueRegiaoDaFilaInvalidaError extends TypeError {
  constructor() {
    super('caminhoDaFilaEstoqueAmazon: região fora da gramática (minúsculas, dígitos, -)');
    this.name = 'AmazonEstoqueRegiaoDaFilaInvalidaError';
  }
}

/**
 * The queue valve is closed (`AMAZON_TASKS_DISABLED=1`): nothing was enqueued.
 *
 * Its OWN class, never another queue's: each promises a different remedy, and a
 * catch written for one must never take another.
 */
export class AmazonEstoqueTarefasDesligadasError extends Error {
  constructor() {
    super(
      'AMAZON_TASKS_DISABLED=1 — a fila de tarefas de estoque está desligada; ' +
        'nada foi enfileirado (a próxima varredura e a reconciliação diária retomam o envio)',
    );
    this.name = 'AmazonEstoqueTarefasDesligadasError';
  }
}

/**
 * This queue's delay bound (module header), for the shared core's whole-second
 * rule: `undefined` or `0` ⇒ none, a whole number of seconds up to
 * {@link MAX_ATRASO_ESTOQUE_S} ⇒ `scheduleDelaySeconds`.
 */
const LIMITE_DE_ATRASO_ESTOQUE: LimiteDeAtrasoListingAmazon = {
  rotulo: 'produtorEstoque.ts',
  maximoS: MAX_ATRASO_ESTOQUE_S,
  descricao: 'uma hora',
};

/** One payload, checked and named, ready for the transport (module header). */
interface EnvioPreparado {
  readonly tarefa: TarefaEstoqueAmazon;
  readonly id: string | null;
  readonly extras: OpcoesDaTarefaEstoqueAmazon | undefined;
}

/**
 * The payload re-checked and its options built (module header): everything a
 * payload can be refused for is refused HERE, before any enqueue of a batch
 * starts.
 *
 * @throws {ZodError} a payload outside the contract.
 * @throws {RangeError} a field outside its name's grammar, or a bad delay.
 */
function preparar(
  payload: TarefaEstoqueAmazon,
  nomeado: boolean,
  atrasoS: number | undefined,
): EnvioPreparado {
  const tarefa = tarefaEstoqueAmazonSchema.parse(payload);
  const id = nomeado ? nomeDaTarefaEstoque(tarefa) : null;
  return {
    tarefa,
    id,
    extras: opcoesDaTarefaListingAmazon(
      id,
      atrasoDaFilaListingAmazon(atrasoS, LIMITE_DE_ATRASO_ESTOQUE),
    ),
  };
}

/**
 * The producer: with the valve closed, every enqueue rejects with
 * {@link AmazonEstoqueTarefasDesligadasError} and the queue is never resolved;
 * otherwise each enqueue resolves the queue and runs through the shared
 * transient naming (module header).
 */
export function criarProdutorEstoqueAmazon(
  opcoes: OpcoesProdutorEstoqueAmazon,
): ProdutorEstoqueAmazon {
  /**
   * This queue, as the shared core's binding: the transport and the valve with
   * its OWN class, both read off `opcoes` at EVERY enqueue.
   */
  const vinculo: VinculoFilaListingAmazon<TarefaEstoqueAmazon> = {
    fila: () => opcoes.fila(),
    get desligado() {
      return opcoes.desligado;
    },
    desligada: () => new AmazonEstoqueTarefasDesligadasError(),
  };
  /** One prepared enqueue; a NAMED one answers `ja-enfileirada` on a held id. */
  const enviar = ({
    tarefa,
    id,
    extras,
  }: EnvioPreparado): Promise<ResultadoEnfileiramentoEstoqueAmazon> =>
    enfileirarNaFilaListingAmazon(vinculo, tarefa, id, extras);

  return {
    async enfileirar(payload, atrasoS) {
      return enviar(preparar(payload, true, atrasoS));
    },

    async enfileirarLote(payloads, opcoesLote = {}) {
      // Every payload is checked BEFORE the first enqueue: a bad one in the
      // middle never leaves a half-sent batch behind a ZodError.
      const preparados = payloads.map((p) => preparar(p, true, opcoesLote.atrasoS));
      return enfileirarLoteListingAmazon(preparados, enviar, opcoesLote.continuar);
    },

    async enfileirarVerificacao(payload, submissionId) {
      const original = tarefaEstoqueAmazonSchema.parse(payload);
      if (!precisaVerificacao(original.origem)) {
        throw new RangeError(
          `produtorEstoque.ts: a origem ${original.origem} não ganha leitura de volta`,
        );
      }
      return enviar(
        preparar(
          {
            v: original.v,
            contaId: original.contaId,
            sku: original.sku,
            origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.verificacao,
            referencia: submissionId,
            depositoId: null,
          },
          true,
          ATRASO_VERIFICACAO_ESTOQUE_S,
        ),
      );
    },

    async enfileirarPausa(payload) {
      await enviar(preparar(payload, false, ATRASO_PAUSA_ESTOQUE_S));
    },
  };
}
