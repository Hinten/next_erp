import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';

/**
 * `enviosPrecoMercadoLivre` (TOP-LEVEL) — the checkpoint/progress doc for the
 * MANUAL "Atualizar preços" bulk price-push job (Step 11 PR-C). There is NO
 * automation: a user clicks the per-conta action in the web UI (PR-D),
 * optionally opting in to price decreases (`baixarPreco`), and one job doc
 * here is the single source of truth for a Cloud Tasks-driven, server-side
 * loop — a clone of the mass-import pattern (`importacoesMercadoLivre`, #621),
 * NOT the Step-10 durable sweep: the job plans one produto-family page at a
 * time, drains the resulting drafts a bounded batch per dispatch
 * (GET-before-PUT on ML, price-only bodies), and re-enqueues itself until the
 * plan is exhausted and the queue (`fila`) drains. Per-item skips/failures are
 * contained (not aborting the job) and recorded up to a cap; the web UI polls
 * this doc for progress.
 *
 * Fields split into three groups:
 *  - job identity/state: `integracaoId`, `status`, `baixarPreco` (the request
 *    toggle the route sanitizes from the body), `startedBy`;
 *  - the resumable cursor: `afterAnchorId` (the plan's keyset cursor over
 *    anchor produtos — see `planejamentoConcluido` for the null
 *    disambiguation) and `fila` (the drafts still to send, at most one plan
 *    page's worth, persisted after EVERY item so a retry resumes exactly
 *    where it left off);
 *  - progress counters (`planejados`/`enviados`/`pulados`/`falhas`/`pausas`
 *    plus the capped `skips`/`failures` samples) surfaced to the UI as-is,
 *    and the terminal `finishedAt`/`erro`.
 *
 * Admin-only / default-deny: NOT registered in `ALL_DOMAINS` (mirrors
 * `importacaoMercadoLivre` — same rationale: only the authed routes
 * (`startPriceSyncJob`, the status poll) and the nested Cloud Function
 * (`processMercadoLivrePriceSync`) ever touch this collection, so there is no
 * client access and the rules generator emits no match block for it).
 */

/** One price-sync job's lifecycle: `running` → `completed` | `failed`. */
export const envioPrecoMercadoLivreStatusSchema = z.enum(['running', 'completed', 'failed']);
export type EnvioPrecoMercadoLivreStatus = z.infer<typeof envioPrecoMercadoLivreStatusSchema>;

/**
 * One planned price send, queued in `fila` at PLAN time and consumed by the
 * send step. `.passthrough()`: the fila round-trips through a schema parse on
 * every persisted checkpoint, so unknown keys a newer planner adds must
 * survive an older consumer's rewrite.
 */
export const envioPrecoFilaItemSchema = z
  .object({
    /**
     * `item`: PUT the price on the item itself (standalone listings, and
     * legacy/anchor sends where ML only accepts one uniform family price).
     * `variationItem`: PUT on a user-product variation item, priced from the
     * CHILD produto when `propagatePriceToChildren` is off.
     */
    kind: z.enum(['item', 'variationItem']),
    /** The ML item id the price is PUT on. */
    itemId: z.string().min(1),
    /** The family ANCHOR produto — the link writeback path segment. */
    produtoId: z.string().min(1),
    /** The child produto a `variationItem` draft was priced from; `null` for `item` drafts. */
    variacaoProdutoId: z.string().min(1).nullable().default(null),
    /** The link doc under the anchor to stamp after a successful send. */
    linkDocId: z.string().min(1),
    /** Reais, `roundReais`'d at PLAN time, sent verbatim by the send step. */
    preco: z.number(),
  })
  .passthrough();
export type EnvioPrecoFilaItem = z.infer<typeof envioPrecoFilaItemSchema>;

/** One contained per-item skip (`itemId` is `null` for plan-time skips with no listing). */
export const envioPrecoSkipSchema = z
  .object({
    itemId: z.string().nullable().default(null),
    produtoId: z.string().min(1),
    code: z.string().min(1),
  })
  .passthrough();
export type EnvioPrecoSkip = z.infer<typeof envioPrecoSkipSchema>;

/** One contained per-item failure — a skip plus the error that caused it. */
export const envioPrecoFailureSchema = envioPrecoSkipSchema.extend({
  error: z.string(),
});
export type EnvioPrecoFailure = z.infer<typeof envioPrecoFailureSchema>;

export const envioPrecoMercadoLivreSchema = z.object({
  /** The connected conta whose linked listings this job pushes prices to. */
  integracaoId: z.string().min(1),
  status: envioPrecoMercadoLivreStatusSchema,
  /**
   * The operator's explicit opt-in to price DECREASES — default OFF, in which
   * case a lower new price skips as `PRECO_ANTIGO_MAIOR`.
   */
  baixarPreco: z.boolean().default(false),
  /** The plan's keyset cursor over anchor produtos — `null` before the first page. */
  afterAnchorId: z.string().nullable().default(null),
  /**
   * Disambiguates the `null` cursor: `null` + `false` = planning not started,
   * `null` + `true` = every page planned. Closes the re-plan window a crash
   * between the final plan checkpoint and the `completed` flip would open.
   */
  planejamentoConcluido: z.boolean().default(false),
  /**
   * At most one plan page's drafts — refilled only when empty, bounding the
   * doc size; drained per dispatch by the send step.
   */
  fila: z.array(envioPrecoFilaItemSchema).default([]),
  /** Total drafts produced by the plan step (informational). */
  planejados: z.number().int().default(0),
  /** Prices successfully PUT on ML (skip-if-equal sends do not count). */
  enviados: z.number().int().default(0),
  /** Total per-item skips (may exceed `skips.length` past the cap). */
  pulados: z.number().int().default(0),
  /** Total per-item failures (may exceed `failures.length` past the cap). */
  falhas: z.number().int().default(0),
  /** 429 rate pauses taken so far (the consumer aborts past `PRICE_SYNC_MAX_PAUSES`). */
  pausas: z.number().int().default(0),
  /**
   * The first `PRICE_SYNC_SKIPS_CAP` skips, for the UI — CAPPED by the
   * consumer; the counters stay exact, these lists are samples.
   */
  skips: z.array(envioPrecoSkipSchema).default([]),
  /** The first `PRICE_SYNC_FAILURES_CAP` failures, for the UI (same cap rule). */
  failures: z.array(envioPrecoFailureSchema).default([]),
  /** The authed uid that clicked "Atualizar preços" (`null` when unknown). */
  startedBy: z.string().nullable().default(null),
  startedAt: millisSinceEpoch(),
  /** Bumped on every persisted checkpoint (plan page, per-item, terminal). */
  updatedAt: millisSinceEpoch(),
  finishedAt: millisSinceEpoch().nullable().default(null),
  /** Set only on `status: 'failed'` — the error that exhausted the retries. */
  erro: z.string().nullable().default(null),
});
export type EnvioPrecoMercadoLivre = z.infer<typeof envioPrecoMercadoLivreSchema>;
