import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import {
  notificacaoResilienciaStatusSchema,
  notificationResilienceFields,
} from './shared/notificationResilience';

/**
 * `notificacoesMercadoLivre` (TOP-LEVEL) — the **failures-only** inbound webhook
 * log. Mercado Livre POSTs a tiny pointer `{_id, resource, user_id, topic,
 * application_id, attempts, sent, received}`; the receiver enqueues it onto a
 * Cloud Tasks queue (`onTaskDispatched`) and acks 200 fast — **without writing
 * Firestore on the happy path**. A document is persisted here ONLY when a
 * notification cannot be processed: the task handler exhausted its retries
 * (`failed`), the seller has no active integração yet (`failed`, sweep re-drives),
 * or the topic is unsupported (`parked`, terminal). The `onSchedule` reprocess
 * sweep re-drives `failed` docs and deletes them on success.
 *
 * This is why the collection is failures-only: keeping every notification just to
 * trigger a Firestore event was pure write cost, and an ungated create trigger
 * gave no control over the ML API call rate — the Cloud Tasks queue does both.
 * The shape still mirrors the old Flutter `NotificationMercadoLivre`
 * (models.dart:349, same collection) so the two apps coexist during dual-run;
 * the legacy app likewise only stored a doc on a processing error.
 *
 * Local resilience fields the legacy wire shape never had: `status`, a LOCAL
 * retry counter `tentativas` (distinct from ML's own delivery `attempts`),
 * `erro`, and `processedAt` (the last-attempt time — the sweep's window gate).
 *
 * Admin-only / default-deny: NOT registered in `ALL_DOMAINS` (like `credenciais`
 * / `tokenDuravel`), so clients can't read it and the rules generator emits no
 * match block. The receiver (Admin SDK route) and the nested functions (Admin
 * SDK) are the only writers/readers.
 */

/**
 * Local processing state (NOT an ML field). Only these two are ever persisted —
 * a successfully processed notification writes NOTHING (the cost win). `failed`
 * is re-driven by the sweep; `parked` is terminal (unknown topic, or a `failed`
 * doc that hit the reprocess cap).
 */
/**
 * Local processing state — an alias of the SHARED
 * `notificacaoResilienciaStatusSchema` so the enum can't drift from what the
 * pipeline in `@delfrance/data/admin/notifications` writes. Kept as a named
 * export because the barrel already publishes it.
 */
export const notificacaoStatusSchema = notificacaoResilienciaStatusSchema;
export type NotificacaoStatus = z.infer<typeof notificacaoStatusSchema>;

export const notificacaoMercadoLivreSchema = z
  .object({
    /**
     * The ML notification id (`_id`/`id`) — normally also the Firestore doc
     * id (the persister keys the failure doc by it). Null on the rare body
     * with no id, where an auto doc id is minted instead.
     */
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

    // ---- Local resilience fields (shared; not on any provider's wire) -----
    // Written/read blind by the pipeline in `@delfrance/data/admin/notifications`.
    ...notificationResilienceFields(),
  })
  .passthrough();

export type NotificacaoMercadoLivre = z.infer<typeof notificacaoMercadoLivreSchema>;

/** The `resource_id` — last path segment of `resource` (old computed getter). */
export function notificacaoResourceId(resource: string): string {
  const segs = resource.split('/').filter(Boolean);
  return segs[segs.length - 1] ?? resource;
}
