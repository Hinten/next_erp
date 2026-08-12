import { z } from 'zod';
import { microsSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/**
 * `backfillPedidosMercadoLivre` (TOP-LEVEL) — the per-conta durable cursor for
 * the flag-gated ML order-backfill sweep (#360, Step 9 PR 4 of umbrella #638).
 * The 15-minute `onSchedule` backstop pages `GET /orders/search` by
 * `order.date_last_updated` for every active conta and re-drives each order
 * found through the EXISTING notification import pipeline (synthetic
 * `orders_v2` tasks). This doc — ONE per conta, **doc id = integracaoId** — is
 * where a conta's progress survives across ticks. Legacy had NO such backfill:
 * this is an approved architecture upgrade, so there are no parity
 * constraints, only this repo's conventions (datetimes in µs since epoch —
 * `microsSinceEpoch()` — converted to ISO only at the ML API boundary).
 *
 * Write discipline (the sweep's — documented here because the fields only make
 * sense together): after a conta's pages+enqueues ALL succeed, the sweep
 * merges `{ cursorUs, lastSweepAtUs, lastError: null }`; on a contained
 * per-conta error it merges `{ lastSweepAtUs, lastError }` WITHOUT advancing
 * `cursorUs`, so the next tick retries the same window. Re-covering is
 * harmless: the sweep queries from `cursorUs` minus a 5-minute overlap and the
 * order import is idempotent + staleness-gated, so duplicates converge.
 *
 * Admin-only / default-deny: bare `{ schema, meta }` (perms `0n`), NOT
 * registered in `ALL_DOMAINS` (mirrors `importacaoMercadoLivre` /
 * `notificacoesWhatsapp` — same rationale: only the nested Cloud Function
 * sweep (Admin SDK) ever touches this collection), so clients can't read it,
 * the rules generator emits no match block, and no rules regen is needed.
 */

export const backfillPedidosMercadoLivreSchema = z.object({
  /**
   * High-water mark (µs) of `order.date_last_updated` already covered by a
   * successful sweep — the next tick queries from `cursorUs - OVERLAP_US`.
   * Null until the conta's first successful sweep (which falls back to the
   * initial 24h lookback instead).
   */
  cursorUs: microsSinceEpoch().nullable().default(null),
  /** When the sweep last touched this conta (µs) — set on success AND on a contained error. */
  lastSweepAtUs: microsSinceEpoch().nullable().default(null),
  /** The last contained per-conta sweep error; reset to null on a clean sweep. */
  lastError: z.string().nullable().default(null),
});
export type BackfillPedidosMercadoLivre = z.infer<typeof backfillPedidosMercadoLivreSchema>;

export const backfillPedidosMercadoLivreMeta: CollectionMetadata = {
  collectionPath: 'backfillPedidosMercadoLivre',
  // No client domain grants these bits — placeholder values. Deliberately
  // NOT registered in `ALL_DOMAINS`, so the rules generator emits no match
  // block and Firestore default-denies every client read/write. Only the
  // Admin SDK (apps/mercado-livre nested functions) reaches it. Mirrors
  // `notificacoesWhatsappMeta`.
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
// shape never gets swept in by accident (mirrors `notificacoesWhatsappSchema`
// / `notificacoesWhatsappMeta`). The admin collection handle
// (`backfillPedidosMercadoLivreCollection`) consumes
// `backfillPedidosMercadoLivreMeta.collectionPath` directly.
