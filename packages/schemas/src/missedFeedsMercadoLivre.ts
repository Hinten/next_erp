import { z } from 'zod';
import { microsSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/** One app-wide query stream. An empty page is the only complete drain. */
export const missedFeedsStreamSchema = z.object({
  topic: z.string().nullable(),
  siteId: z.string().nullable(),
  found: z.number().int().nonnegative(),
  novos: z.number().int().nonnegative(),
  enqueued: z.number().int().nonnegative(),
  skippedTopic: z.number().int().nonnegative(),
  skippedIgnorado: z.number().int().nonnegative(),
  skippedInvalid: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  complete: z.boolean(),
  truncated: z.boolean(),
  error: z.string().nullable(),
});
export type MissedFeedsStream = z.infer<typeof missedFeedsStreamSchema>;

/**
 * Admin-only health for the daily backstop (#812, #1292). New writes use
 * app-<appId>, not an integration ID. Old per-seller diagnostic rows are not
 * consumed. No business data or credentials change shape.
 *
 * No cursor: late-filed entries would be skipped forever by a sent watermark.
 * The daily period and 48h retention bound replay instead. lastSuccessAtUs is
 * advanced only when ALL streams drain; partial counters always describe the
 * current attempt. The writer compares lastSweepAtUs inside its transaction,
 * so a slower, older run cannot erase a newer result.
 */
export const missedFeedsMercadoLivreSchema = z.object({
  lastSweepAtUs: microsSinceEpoch().nullable().default(null),
  lastSuccessAtUs: microsSinceEpoch().nullable().default(null),
  appId: z.string().nullable().default(null),
  selectedIntegracaoId: z.string().nullable().default(null),
  complete: z.boolean().default(false),
  lastError: z.string().nullable().default(null),
  lastFoundCount: z.number().int().nullable().default(null),
  lastEnqueuedCount: z.number().int().nullable().default(null),
  lastSkippedCount: z.number().int().nullable().default(null),
  lastTruncated: z.boolean().nullable().default(null),
  streams: z.array(missedFeedsStreamSchema).default([]),
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
