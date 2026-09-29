/**
 * The NF-e upload's task contract (#1522, step 14): the Cloud Tasks payload,
 * the enqueue seam, and the in-memory context the two phases share.
 *
 * ## What the payload carries — and what it deliberately does not
 *
 * `{ pedidoId, nfeId, fase, adiamentosSerpro, pausas, reverificacoes }` and
 * nothing else. NO conta, NO order number and NO access key: the conta and the
 * order number are re-derived from the FRESH pedido on every delivery (zero
 * extra reads — the handler reads the pedido anyway), and the key is read from
 * the NF-e's own XML. A Cloud Tasks payload is visible in the console and in
 * the dispatch logs, so a key in the payload would be a key in a log.
 *
 * The three counters are the self re-enqueue ledgers — each spends no queue
 * attempt, so the queue's own `retryCount` cannot bound them:
 * - `adiamentosSerpro` — re-enqueues spent waiting for SERPRO;
 * - `pausas` — re-enqueues spent on rate limits (burst and daily together);
 * - `reverificacoes` — rechecks already consumed.
 *
 * ⚠️ `.strict()`, the step-13 shape: this queue has exactly the producers this
 * folder names (the trigger, the route, the CLI and the handler's own
 * re-enqueues), so a payload carrying anything more is a producer this module
 * does not know — dropped by the dispatcher with ONE `error` line that names
 * field paths only, never the values.
 */
import type { ShopeeClient } from '@delfrance/integrations-shopee';
import { z } from 'zod';

/* ---------------------------------- the phase --------------------------------- */

/**
 * Which half of the flow a task runs: the upload itself, or a later read-only
 * recheck of what Shopee holds. A recheck NEVER uploads.
 */
export const faseNfeShopeeSchema = z.enum(['envio', 'reverificacao']);

/** The two phases, as a type. */
export type FaseNfeShopee = z.infer<typeof faseNfeShopeeSchema>;

/** The closed set of {@link FaseNfeShopee}, so code names a phase instead of spelling it. */
export const FASE_NFE_SHOPEE = {
  envio: 'envio',
  reverificacao: 'reverificacao',
} as const satisfies Record<string, FaseNfeShopee>;

/* --------------------------------- the payload -------------------------------- */

/** A ledger: a whole, non-negative count, `0` when the producer omits it. */
const contador = z.number().int().min(0).default(0);

/**
 * The Cloud Tasks body. `fase` defaults to the upload, and every counter to
 * `0`, so the trigger's first enqueue is just `{ pedidoId, nfeId }`.
 */
export const tarefaNfeShopeeSchema = z
  .object({
    pedidoId: z.string().min(1),
    nfeId: z.string().min(1),
    fase: faseNfeShopeeSchema.default(FASE_NFE_SHOPEE.envio),
    adiamentosSerpro: contador,
    pausas: contador,
    reverificacoes: contador,
  })
  .strict();

/** A PARSED payload — every default applied. */
export type TarefaNfeShopee = z.output<typeof tarefaNfeShopeeSchema>;

/* ------------------------------- the enqueue seam ------------------------------ */

/** What a caller may ask of ONE enqueue beyond the payload itself. */
export interface OpcoesDeEnfileiramentoNfe {
  /**
   * Seconds to hold the task before it is dispatched — the SERPRO wait, a
   * pause, or a recheck's delay.
   *
   * ⚠️ Absent means "dispatch now", and that is NOT the same request as a delay
   * whose value happens to be `undefined`: the scheduler OMITS the options
   * object when no delay was asked, rather than forwarding an explicit
   * `undefined` to Cloud Tasks.
   */
  readonly scheduleDelaySeconds?: number;
}

/**
 * The enqueue seam. The trigger, the route, the CLI and the handler depend on
 * this interface, never on the transport, so their tests pass a recorder; the
 * real one is the folder's scheduler module.
 */
export interface AgendadorNfeShopee {
  enqueue(payload: TarefaNfeShopee, opts?: OpcoesDeEnfileiramentoNfe): Promise<void>;
}

/* ------------------------------ the shared context ----------------------------- */

/**
 * What the common prefix of both phases has established once it reaches the
 * order read — handed to the phase-specific half in memory, never enqueued.
 *
 * ⚠️ It holds the order number and the key, which is exactly why it is never a
 * payload and never logged whole: the completion log names `pedidoId` and
 * `nfeId` only.
 */
export interface ContextoNfeShopee {
  /** The pedido document id. */
  readonly pedidoId: string;
  /** The NF-e document id. */
  readonly nfeId: string;
  /** The conta (integração) the pedido proves it belongs to. */
  readonly integracaoId: string;
  /** The pedido's DISPLAY number — the aviso's `params.pedido`. */
  readonly numero: string;
  /** The access key read from OUR NF-e's own XML — "ours" at every read. */
  readonly nossaChave: string;
  /** The conta's SHOP client (never the partner client). */
  readonly client: ShopeeClient;
}
