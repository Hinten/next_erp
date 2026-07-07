import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';

/**
 * `notificacoesMercadoLivre` (TOP-LEVEL) — the persist-first inbound webhook
 * log. Mercado Livre POSTs a tiny pointer `{_id, resource, user_id, topic,
 * application_id, attempts, sent, received}`; the receiver persists it BLIND
 * (no account lookup, keyed by the ML `_id` for natural cross-delivery dedup)
 * and acks 200 fast, then a Firestore-trigger processor fetches the `resource`
 * and applies it. This mirrors the old Flutter `NotificationMercadoLivre`
 * (models.dart:349, collection `notificacoesMercadoLivre`) — same wire fields
 * so the two apps coexist during dual-run.
 *
 * The new app INVERTS the legacy persist model (legacy stored a doc only on a
 * processing error; the doc's mere existence meant "retry"). Here EVERY
 * notification is persisted for reprocess + debug, so the schema adds the
 * local resilience fields the legacy wire shape never had: `status`, a LOCAL
 * retry counter `tentativas` (distinct from ML's own delivery `attempts`),
 * `erro`, and `processedAt`. The reprocess sweep filters on `status` + the
 * inbound `received` gate.
 *
 * Admin-only / default-deny: NOT registered in `ALL_DOMAINS` (like
 * `credenciais` / `tokenDuravel`), so clients can't read it and the rules
 * generator emits no match block. The receiver (Admin SDK route) and the
 * nested functions (Admin SDK) are the only writers/readers.
 */

/** Local processing state (NOT an ML field). */
export const notificacaoStatusSchema = z.enum(['pending', 'done', 'failed', 'parked']);
export type NotificacaoStatus = z.infer<typeof notificacaoStatusSchema>;

export const notificacaoMercadoLivreSchema = z
  .object({
    /** The ML notification id (`_id`/`id`) — also the Firestore doc id. */
    id: z.string().nullable().default(null),
    /** ML resource pointer, e.g. `/orders/2000...` or `/items/MLB123`. */
    resource: z.string().min(1),
    /** The seller id — resolves the owning integração (equality query). */
    user_id: z.number().int().nullable().default(null),
    topic: z.string().min(1),
    application_id: z.number().int().nullable().default(null),
    /** ML's OWN delivery-attempt counter from the payload (not our retry). */
    attempts: z.number().int().nullable().default(null),
    /** ML timestamps — tolerant of ISO-8601 or epoch millis. */
    sent: millisSinceEpoch().nullable().default(null),
    received: millisSinceEpoch().nullable().default(null),

    // ---- Local resilience fields (new-app, not on the ML wire) ------------
    status: notificacaoStatusSchema.default('pending'),
    /** LOCAL reprocess counter (incremented by the processor/sweep). */
    tentativas: z.number().int().default(0),
    erro: z.string().nullable().default(null),
    processedAt: millisSinceEpoch().nullable().default(null),
  })
  .passthrough();

export type NotificacaoMercadoLivre = z.infer<typeof notificacaoMercadoLivreSchema>;

/** The `resource_id` — last path segment of `resource` (old computed getter). */
export function notificacaoResourceId(resource: string): string {
  const segs = resource.split('/').filter(Boolean);
  return segs[segs.length - 1] ?? resource;
}
