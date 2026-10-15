/**
 * The NF-e upload's task contract (#1522, step 14): the Cloud Tasks payload,
 * the enqueue seam, the in-memory context the two phases share, and the
 * dependencies and result type of ONE execution of either phase.
 *
 * The last two live here — not in the handler module — so the upload handler
 * and the recheck name ONE declaration each: the recheck may not import the
 * handler (it would be a cycle), and a structural copy kept "in step" by a
 * comment is exactly the drift the root CLAUDE.md warns about.
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
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import type { AvisoDeps } from '../avisos/autorizacao';
import type { MotivoCarimbo } from './carimboFreteNfe';
import type { DesfechoNfeShopee, MotivoNfeShopee } from './errosNfe';

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

/* --------------------------- one execution, both phases --------------------------- */

/**
 * Everything one execution needs (orchestrator amendment W3-1). The upload
 * handler takes all of it; the recheck uses `db`, `scheduler`, `nowMs` and
 * `increment`.
 */
export interface DepsNfeShopee {
  readonly db: Firestore;
  /** The NF-e queue — the recheck, the pauses, the SERPRO waits. */
  readonly scheduler: AgendadorNfeShopee;
  /** The dispatcher's ONE clock read, in MILLISECONDS. No module of the flow reads one. */
  readonly nowMs: number;
  /**
   * `(by) => FieldValue.increment(by)` — the aviso writer needs the sentinel, and
   * this folder may not make the runtime import that produces it.
   */
  readonly increment: AvisoDeps['increment'];
  /**
   * Jitter, in whole SECONDS in `[0, maxS]`, added to every pause's delay so a
   * fleet paused on the same limit does not resume on the same second. The
   * randomness belongs to the dispatcher; a test passes a constant.
   */
  jitterSec(maxS: number): number;
  /**
   * The conta's SHOP client. Default: `loadShopeeContext(...).createShopClient()`
   * — called only after the conta gate passed.
   */
  readonly resolveClient?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
}

/**
 * What one execution ended in (reconcile §2.8) — the upload's, or a recheck's
 * (whose `substituicao` is always `false`: a substitution is an UPLOAD decision).
 */
export interface ResultadoNfeShopee {
  readonly desfecho: DesfechoNfeShopee;
  /** `null` only when a 200's read-back could not be read (the upload landed). */
  readonly motivo: MotivoNfeShopee | null;
  /** `null` only for a payload that did not parse. */
  readonly fase: FaseNfeShopee | null;
  /** The upload replaced a CANCELLED sibling NF-e's key on the order. */
  readonly substituicao: boolean;
  /** The frete stamp's answer, when the motivo stamps. */
  readonly carimbo: MotivoCarimbo | null;
  readonly avisado: boolean;
  /** THIS execution closed the pedido's open aviso. */
  readonly resolvido: boolean;
}
