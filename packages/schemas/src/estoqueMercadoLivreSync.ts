import { z } from 'zod';
import { microsSinceEpoch, millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/**
 * `estoqueMercadoLivreSync` (TOP-LEVEL) — the per-conta durable state doc for
 * the flag-gated ML stock-sync sweeps (Step 10). The 15-minute incremental
 * sweep and the 2AM daily sweep discover the changed produto families, compute
 * every quantity at sweep time and enqueue one Cloud Task per ML API call (the
 * task payload CARRIES the quantities — the send handler transmits them
 * verbatim, never re-reading stock); this doc — ONE per conta,
 * **doc id = integracaoId** — is where a conta's progress and health survive
 * across ticks. Datetimes are µs since epoch (`microsSinceEpoch()`), the state
 * doc standard; produto/estoque source fields stay ms and are converted at the
 * boundary.
 *
 * Write discipline (the sweeps' + the send handler's — documented here because
 * the fields only make sense together): after a conta's incremental discovery
 * + enqueues ALL succeed, the sweep merges `{ cursorUs: toUs, lastSweepAtUs,
 * lastError: null }`; the daily sweep merges `{ lastDailyAtUs, lastError: null }`
 * WITHOUT touching `cursorUs`. A TRUNCATED sweep (page or task cap) merges
 * `{ continuacao }` instead — the frozen window + keyset position the NEXT tick
 * resumes — and leaves `cursorUs` alone until that continuation drains. On a
 * contained per-conta error either sweep merges `{ lastError, lastErrorAtUs }`
 * without advancing the cursor, so the next tick retries the same window
 * (re-covering is harmless — the re-run recomputes quantities at ITS OWN sweep
 * time and enqueues fresh payloads, which the send handler transmits verbatim).
 * The send-task handler owns the 429 pair: on a rate-limit it merges
 * `{ pausedUntilUs, pauseCount+1 }` and both the pause gate and later sweeps
 * honour it per conta (a paused conta is skipped whole, cursor + continuacao
 * untouched).
 *
 * Admin-only / default-deny: bare `{ schema, meta }` (perms `0n`), NOT
 * registered in `ALL_DOMAINS` (mirrors `backfillPedidosMercadoLivre` /
 * `notificacoesWhatsapp` — same rationale: only the nested Cloud Function
 * sweeps + task handler (Admin SDK) ever touch this collection), so clients
 * can't read it, the rules generator emits no match block, and no rules regen
 * is needed.
 */

export const estoqueMercadoLivreSyncSchema = z.object({
  /**
   * Incremental sweep floor (µs) — the last window `to` fully covered by a
   * successful incremental sweep; the next tick queries estoque changes from
   * `cursorUs` (minus the overlap slack), capped by the max-lookback. Null
   * until the conta's first successful incremental sweep (which falls back to
   * the default window instead). The daily sweep never touches it.
   */
  cursorUs: microsSinceEpoch().nullable().default(null),
  /** When the 15-minute incremental sweep last completed for this conta (µs). */
  lastSweepAtUs: microsSinceEpoch().nullable().default(null),
  /** When the 2AM daily sweep last completed for this conta (µs). */
  lastDailyAtUs: microsSinceEpoch().nullable().default(null),
  /**
   * When the force-all RECONCILIATION pass last completed for this conta (µs).
   * Its own field, not `lastDailyAtUs`: the 02:00 pass is a flat 24h window and
   * does NOT reconcile (#806 S11), so conflating the two would tell an operator
   * a full pass ran when none did. Null until the first reconciliation.
   */
  lastReconciliacaoAtUs: microsSinceEpoch().nullable().default(null),
  /** The last contained per-conta error; reset to null on a clean sweep. */
  lastError: z.string().nullable().default(null),
  /** When `lastError` was recorded (µs) — outlives the reset-to-null on recovery. */
  lastErrorAtUs: microsSinceEpoch().nullable().default(null),
  /**
   * 429 pause gate (µs), per conta: while `pausedUntilUs > now` the send-task
   * handler re-enqueues instead of calling ML, and one throttled conta never
   * halts the healthy ones. Set by the handler on a rate-limit response
   * (now + pause duration, or Retry-After when present).
   */
  pausedUntilUs: microsSinceEpoch().nullable().default(null),
  /** How many 429 pauses this conta has accumulated (observability counter). */
  pauseCount: z.number().int().default(0),
  /**
   * The frozen keyset position + window of a **TRUNCATED** sweep. A sweep that
   * hits the page cap or the task cap stores where it stopped
   * (`afterAnchorId`) together with the window it was running
   * (`changedSinceMs` / `vendaCutoffUs`) and the ORIGINAL sweep's start
   * (`startedAtUs`); the next tick **RESUMES that same sweep** — same window,
   * same filter mode (`vendaCutoffUs == null` ⇒ daily semantics: the pedidos
   * probe was skipped, so nothing reads the sales flag) — instead of
   * restarting page 1 of a re-derived window, which is how a conta with a
   * standing backlog would otherwise never reach its tail. Cleared (`null`)
   * the moment the continuation drains; an incremental continuation then
   * advances `cursorUs` to `startedAtUs`, because the frozen window is covered
   * exactly up to the original sweep's start.
   */
  continuacao: z
    .object({
      /** Keyset cursor: THE query resumes after this produto anchor id. */
      afterAnchorId: z.string().min(1),
      /** The frozen window start (ms since epoch) the truncated sweep used. */
      changedSinceMs: millisSinceEpoch(),
      /** The frozen sales-probe lower bound (µs) — null ⇒ daily semantics. */
      vendaCutoffUs: microsSinceEpoch().nullable(),
      /** When the ORIGINAL (pre-truncation) sweep started (µs). */
      startedAtUs: microsSinceEpoch(),
    })
    .nullable()
    .default(null),
});
export type EstoqueMercadoLivreSync = z.infer<typeof estoqueMercadoLivreSyncSchema>;

export const estoqueMercadoLivreSyncMeta: CollectionMetadata = {
  collectionPath: 'estoqueMercadoLivreSync',
  // No client domain grants these bits — placeholder values. Deliberately
  // NOT registered in `ALL_DOMAINS`, so the rules generator emits no match
  // block and Firestore default-denies every client read/write. Only the
  // Admin SDK (apps/mercado-livre nested functions) reaches it. Mirrors
  // `backfillPedidosMercadoLivreMeta`.
  permissions: {
    read: 0n,
    write: 0n,
    delete: 0n,
  },
};

// NOTE: intentionally exported as two BARE constants (`...Schema` +
// `...Meta`), not a single `{ schema, meta }` DomainSchema object, and NOT
// added to `ALL_DOMAINS` — `registry.test.ts`'s `isDomainSchema()` only flags
// a single export carrying both a `.schema` and a `.meta` property, so this
// shape never gets swept in by accident (mirrors
// `backfillPedidosMercadoLivreSchema` / `backfillPedidosMercadoLivreMeta`).
// The admin collection handle (`estoqueMercadoLivreSyncCollection`) consumes
// `estoqueMercadoLivreSyncMeta.collectionPath` directly.
