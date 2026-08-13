import { z } from 'zod';
import { microsSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/**
 * `missedFeedsMercadoLivre` (TOP-LEVEL) — the per-conta **health record** for
 * the flag-gated `missed_feeds` backstop sweep (#812). The 05:00 `onSchedule`
 * job pages `GET /missed_feeds` for every active conta and replays each entry
 * through the existing notification queue; this doc — ONE per conta,
 * **doc id = integracaoId** — is where a conta's last outcome is durably
 * visible. Legacy had no such backstop, so there are no parity constraints,
 * only this repo's conventions (datetimes in µs since epoch —
 * `microsSinceEpoch()`).
 *
 * ⚠️ **There is deliberately NO `cursorUs` here, and that absence is the
 * design.** `GET /missed_feeds` has no time-filter parameter, so a cursor could
 * only filter a set we already paid to fetch — zero saving, and a fatal failure
 * mode: an entry is filed only ~1h after ML gives up, so one *sent* at 04:55
 * lands in the feed at ~05:55, AFTER the 05:00 run, and a `sent`-based cursor
 * would skip it permanently. The `OVERLAP_US` trick in the order backfill does
 * not transfer — there the cursor is what bounds a server-side query; here ML's
 * 2-day retention is the bound. What replaces it is a scheduling invariant:
 *
 *     SCHEDULE_PERIOD (24h) × 2  ≤  RETENTION (48h)
 *
 * so every entry is visible on at least one run and usually two. Duplicates are
 * harmless (the import path is idempotent and staleness-gated, and a failure doc
 * is keyed by ML's `_id`, so a re-persist hits `ALREADY_EXISTS`).
 *
 * Consequence: this doc is **write-only from the sweep's perspective** — never
 * read back, 0 reads and 1 merge per conta per day. It earns its keep as the
 * only durable, queryable "which contas are currently broken" record; Cloud
 * Logging has retention limits and no such view.
 *
 * Write discipline (the sweep's — documented here because the fields only make
 * sense together): after a conta's pages+enqueues ALL succeed the sweep merges
 * `{ lastSweepAtUs, lastError: null, lastFound*, lastTruncated }`; on a
 * contained per-conta error it merges `{ lastSweepAtUs, lastError }` only. A
 * truncated tick is a capacity signal, not an error — it sets `lastTruncated`
 * and leaves `lastError` null.
 *
 * ⚠️ **The name must not start with `notificacoes`.** Guards B and C in
 * `packages/data/src/admin/notifications/notificationGuardrails.test.ts` fire on
 * any admin collection whose path does, and would demand a
 * `defineNotificationPipeline` consumer plus a `(status, processedAt)` composite
 * index that this collection will never have.
 *
 * Admin-only / default-deny: bare `{ schema, meta }` (perms `0n`), NOT
 * registered in `ALL_DOMAINS` (mirrors `backfillPedidosMercadoLivre` — same
 * rationale: only the nested Cloud Function sweep (Admin SDK) ever touches this
 * collection), so clients can't read it, the rules generator emits no match
 * block, and no rules regen is needed.
 */

export const missedFeedsMercadoLivreSchema = z.object({
  /** When the sweep last touched this conta (µs) — set on success AND on a contained error. */
  lastSweepAtUs: microsSinceEpoch().nullable().default(null),
  /** The last contained per-conta sweep error; reset to null on a clean sweep. */
  lastError: z.string().nullable().default(null),
  /** Entries this conta's paged read returned on the last clean sweep. */
  lastFoundCount: z.number().int().nullable().default(null),
  /** Of those, the ones actually enqueued onto the notification queue. */
  lastEnqueuedCount: z.number().int().nullable().default(null),
  /**
   * Of those, the ones REJECTED — an unknown topic, or an entry with no usable
   * `resource`/`topic`. It deliberately does NOT count entries skipped as
   * duplicates of one already seen this tick: those are expected (ML retains an
   * entry for 2 days, so a daily run sees each one 2–3 times) and counting them
   * here would make a healthy run look like it was dropping work. The duplicate
   * count is `lastFoundCount − lastEnqueuedCount − lastSkippedCount`.
   */
  lastSkippedCount: z.number().int().nullable().default(null),
  /** `true` when the page cap was hit with backlog remaining — capacity, not error. */
  lastTruncated: z.boolean().nullable().default(null),
});
export type MissedFeedsMercadoLivre = z.infer<typeof missedFeedsMercadoLivreSchema>;

export const missedFeedsMercadoLivreMeta: CollectionMetadata = {
  collectionPath: 'missedFeedsMercadoLivre',
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
// `backfillPedidosMercadoLivreSchema` / `...Meta`). The admin collection handle
// (`missedFeedsMercadoLivreCollection`) consumes
// `missedFeedsMercadoLivreMeta.collectionPath` directly.
