/**
 * The price task's PRODUCER, pure (step 13, PR 13-d): what an enqueue of a
 * `preco-sku` task means. Price tasks ride the JOBS queue
 * (`processAmazonListingsJob`, `feeds/agendadorLotes.ts`), so this producer
 * has no queue of its own: it binds the listings flows' shared producer core
 * (`listings/produtorListing.ts`: one enqueue, the whole-second delays, the
 * batch) to the jobs queue — its path (`caminhoDaFilaLotesAmazon`), its valve
 * class ({@link AmazonLotesTarefasDesligadasError}) and its delay cap
 * (`MAX_ATRASO_LOTE_S`) — with the transport handed in as
 * {@link OpcoesProdutorPrecoAmazon}, resolved per enqueue, so a caller that
 * enqueues nothing touches no SDK. The jobs producer's own typed transport
 * carries the feed core's payloads only; a root binds this one to the same
 * queue path.
 *
 * Nothing here reads the process environment or imports the Cloud Tasks SDK,
 * so an App Hosting route may build it over the transport its root binds.
 *
 * ## Five entries, and which of them NAME their task
 *
 * A task NAME is a Cloud Tasks id: a create whose id the queue already holds is
 * refused for about an hour after that task RAN, so a name makes an enqueue
 * idempotent (rule 7 tier 0) and a wrong name swallows a later legitimate one.
 *
 *  - {@link ProdutorPrecoAmazon.enfileirar} and
 *    {@link ProdutorPrecoAmazon.enfileirarLote}: NAMED by the payload's own
 *    name (`nomeDaTarefaPrecoAmazon`: the origem, the conta, the reference and
 *    the SKU), so a retried request, run or hand-off is one task per SKU, and
 *    Cloud Tasks' refusal of a held id answers `ja-enfileirada`. A batch runs
 *    at most {@link LARGURA_LOTE_PRECO_AMAZON} enqueues at once, with the
 *    caller's deadline asked before STARTING each.
 *  - {@link ProdutorPrecoAmazon.enfileirarVerificacao}: the ONE check after an
 *    accepted send, `origem: 'verificacao'`, NAMED after Amazon's
 *    `submissionId` and delayed {@link ATRASO_VERIFICACAO_PRECO_S} (the
 *    documented upper bound of the lag before a listing shows a change). It
 *    carries the ORIGINAL send's `baixarPreco` and `solicitadoEmMs`, and the
 *    price-issue codes read before that send. It refuses a payload that is
 *    itself a check (`RangeError`): a check never chains a second one.
 *  - {@link ProdutorPrecoAmazon.enfileirarEspera}: the task again, UNNAMED,
 *    {@link ATRASO_ESPERA_FEED_PRECO_S} later — it met a healthy price feed in
 *    flight.
 *  - {@link ProdutorPrecoAmazon.enfileirarPausa}: the task again, UNNAMED,
 *    {@link ATRASO_PAUSA_PRECO_S} later — Amazon throttled it (a 429).
 *
 * The two waits are UNNAMED because a name would collide with the task that is
 * still running under it, and a tombstone would refuse the next wait.
 *
 * Every payload is re-checked against `tarefaPrecoSkuAmazonSchema`, and its
 * name and delay minted, before any enqueue starts (a batch with one bad
 * payload enqueues nothing). A payload never carries a price: the task
 * computes it when it runs.
 *
 * ## What a rejection MEANS
 *
 * - {@link AmazonLotesTarefasDesligadasError} — the queue valve
 *   (`AMAZON_TASKS_DISABLED=1`) is closed: nothing enqueued, the queue never
 *   resolved.
 * - `AmazonTarefasTransitoriasError` — Cloud Tasks hiccupped, named by
 *   `core/filaTarefas.ts`'s shared classifier.
 * - `AmazonLotesRegiaoDaFilaInvalidaError` — the root's region is outside the
 *   queue-path grammar (a broken deploy, named by the path builder).
 * - anything else, rethrown EXACTLY as it was thrown (a broken deploy, a root's
 *   `MissingRegionError`, a coding bug).
 */
import { AmazonLotesTarefasDesligadasError, MAX_ATRASO_LOTE_S } from '../feeds/agendadorLotes';
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
  ORIGEM_TAREFA_PRECO_AMAZON,
  type TarefaPrecoSkuAmazon,
  nomeDaTarefaPrecoAmazon,
  tarefaPrecoSkuAmazonSchema,
} from './tarefaPreco';

/** The check's delay, in seconds: the documented upper bound (15 min) of a listing's lag. */
export const ATRASO_VERIFICACAO_PRECO_S = 900;

/** A throttled task's re-enqueue delay, in seconds. */
export const ATRASO_PAUSA_PRECO_S = 60;

/** A task's wait behind a healthy price feed, in seconds: a waiting batch's own re-enqueue delay. */
export const ATRASO_ESPERA_FEED_PRECO_S = 300;

/** The most enqueues one batch keeps in flight: the shared core's. */
export const LARGURA_LOTE_PRECO_AMAZON = LARGURA_LOTE_LISTING_AMAZON;

/** What one enqueue carries besides the payload: a delay, and a task id when named. */
export type OpcoesDaTarefaPrecoAmazon = OpcoesDaTarefaListingAmazon;

/**
 * The transport, as a root binds it to the jobs queue's path — structurally,
 * the Admin SDK's `TaskQueue<TarefaPrecoSkuAmazon>`, of which only
 * `enqueue(data, opts?)` is used.
 */
export type FilaPrecoAmazon = FilaListingAmazon<TarefaPrecoSkuAmazon>;

/** What a NAMED enqueue did. */
export type ResultadoEnfileiramentoPrecoAmazon = ResultadoEnfileiramentoListingAmazon;

/** What a batch did, counted. */
export type ResultadoLotePrecoAmazon = ResultadoLoteListingAmazon;

/** A batch's options: the producer's deadline. */
export interface OpcoesLotePrecoAmazon {
  /** Asked before STARTING each payload; `false` ⇒ nothing more is started. */
  readonly continuar?: () => boolean;
}

/** The enqueue seam the price task, a price run, a feed's hand-off and the manual route depend on. */
export interface ProdutorPrecoAmazon {
  /** ONE payload, named by its own fields (module header). */
  enfileirar(tarefa: TarefaPrecoSkuAmazon): Promise<ResultadoEnfileiramentoPrecoAmazon>;
  /** Many payloads, each named by its own fields, at most {@link LARGURA_LOTE_PRECO_AMAZON} at once. */
  enfileirarLote(
    tarefas: readonly TarefaPrecoSkuAmazon[],
    opcoes?: OpcoesLotePrecoAmazon,
  ): Promise<ResultadoLotePrecoAmazon>;
  /** The check of `tarefa`'s accepted send, named after `submissionId` (module header). */
  enfileirarVerificacao(
    tarefa: TarefaPrecoSkuAmazon,
    submissionId: string,
    codigosAntes: readonly string[],
  ): Promise<ResultadoEnfileiramentoPrecoAmazon>;
  /** `tarefa` again, UNNAMED, after {@link ATRASO_ESPERA_FEED_PRECO_S} (a price feed in flight). */
  enfileirarEspera(tarefa: TarefaPrecoSkuAmazon): Promise<void>;
  /** `tarefa` again, UNNAMED, after {@link ATRASO_PAUSA_PRECO_S} (a throttled task). */
  enfileirarPausa(tarefa: TarefaPrecoSkuAmazon): Promise<void>;
}

export interface OpcoesProdutorPrecoAmazon {
  /**
   * The jobs queue, resolved PER ENQUEUE and only when the valve is open: a
   * root's region guard then rejects that enqueue (rethrown untouched) instead
   * of failing a module load, and a closed valve never touches the SDK at all.
   */
  readonly fila: () => FilaPrecoAmazon;
  /** The queue valve, as the root read it (exactly `'1'` closes it). */
  readonly desligado: boolean;
}

/**
 * The jobs queue's delay bound, for the shared core's whole-second rule:
 * `undefined` or `0` ⇒ none, a whole number of seconds up to
 * `MAX_ATRASO_LOTE_S` (one day) ⇒ `scheduleDelaySeconds`.
 */
const LIMITE_DE_ATRASO_PRECO: LimiteDeAtrasoListingAmazon = {
  rotulo: 'produtorPreco.ts',
  maximoS: MAX_ATRASO_LOTE_S,
  descricao: 'um dia',
};

/** One payload, checked and named, ready for the transport (module header). */
interface EnvioPreparado {
  readonly tarefa: TarefaPrecoSkuAmazon;
  readonly id: string | null;
  readonly extras: OpcoesDaTarefaPrecoAmazon | undefined;
}

/**
 * The payload re-checked and its options built (module header): everything a
 * payload can be refused for is refused HERE, before any enqueue starts.
 *
 * @throws {ZodError} a payload outside the contract.
 * @throws {RangeError} a field outside its name's grammar, or a bad delay.
 */
function preparar(
  payload: TarefaPrecoSkuAmazon,
  nomeado: boolean,
  atrasoS: number | undefined,
): EnvioPreparado {
  const tarefa = tarefaPrecoSkuAmazonSchema.parse(payload);
  const id = nomeado ? nomeDaTarefaPrecoAmazon(tarefa) : null;
  return {
    tarefa,
    id,
    extras: opcoesDaTarefaListingAmazon(
      id,
      atrasoDaFilaListingAmazon(atrasoS, LIMITE_DE_ATRASO_PRECO),
    ),
  };
}

/**
 * The producer: with the valve closed, every enqueue rejects with
 * {@link AmazonLotesTarefasDesligadasError} and the queue is never resolved;
 * otherwise each enqueue resolves the queue and runs through the shared
 * transient naming (module header).
 */
export function criarProdutorPrecoAmazon(opcoes: OpcoesProdutorPrecoAmazon): ProdutorPrecoAmazon {
  /**
   * The jobs queue, as the shared core's binding: the transport and the valve
   * with the jobs queue's OWN class, both read off `opcoes` at EVERY enqueue.
   */
  const vinculo: VinculoFilaListingAmazon<TarefaPrecoSkuAmazon> = {
    fila: () => opcoes.fila(),
    get desligado() {
      return opcoes.desligado;
    },
    desligada: () => new AmazonLotesTarefasDesligadasError(),
  };
  /** One prepared enqueue; a NAMED one answers `ja-enfileirada` on a held id. */
  const enviar = ({
    tarefa,
    id,
    extras,
  }: EnvioPreparado): Promise<ResultadoEnfileiramentoPrecoAmazon> =>
    enfileirarNaFilaListingAmazon(vinculo, tarefa, id, extras);

  return {
    async enfileirar(payload) {
      return enviar(preparar(payload, true, undefined));
    },

    async enfileirarLote(payloads, opcoesLote = {}) {
      // Every payload is checked BEFORE the first enqueue: a bad one in the
      // middle never leaves a half-sent batch behind a ZodError.
      const preparados = payloads.map((p) => preparar(p, true, undefined));
      return enfileirarLoteListingAmazon(preparados, enviar, opcoesLote.continuar);
    },

    async enfileirarVerificacao(payload, submissionId, codigosAntes) {
      const original = tarefaPrecoSkuAmazonSchema.parse(payload);
      if (original.origem === ORIGEM_TAREFA_PRECO_AMAZON.verificacao) {
        throw new RangeError('produtorPreco.ts: uma verificação nunca encadeia outra');
      }
      return enviar(
        preparar(
          {
            v: original.v,
            tipo: original.tipo,
            contaId: original.contaId,
            sku: original.sku,
            origem: ORIGEM_TAREFA_PRECO_AMAZON.verificacao,
            referencia: submissionId,
            parte: null,
            baixarPreco: original.baixarPreco,
            solicitadoEmMs: original.solicitadoEmMs,
            codigosAntes: [...codigosAntes],
          },
          true,
          ATRASO_VERIFICACAO_PRECO_S,
        ),
      );
    },

    async enfileirarEspera(payload) {
      await enviar(preparar(payload, false, ATRASO_ESPERA_FEED_PRECO_S));
    },

    async enfileirarPausa(payload) {
      await enviar(preparar(payload, false, ATRASO_PAUSA_PRECO_S));
    },
  };
}
