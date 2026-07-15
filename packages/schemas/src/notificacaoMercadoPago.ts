import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';

/**
 * `notificacoesMercadoPago` (TOP-LEVEL) — the **failures-only** inbound
 * webhook log for Mercado Pago payment notifications (#531). Mirrors
 * `notificacaoMercadoLivreSchema` closely: MP POSTs a tiny event pointer
 * (`{id, type/topic, data: {id}, user_id, live_mode, date_created, ...}`); the
 * receiver enqueues it onto a Cloud Tasks queue and acks 200 fast — **without
 * writing Firestore on the happy path**. A document is persisted here ONLY
 * when a notification cannot be processed: the task handler exhausted its
 * retries (`failed`), the account has no linked `metodo_pgto` yet (`failed`,
 * sweep re-drives), or the event is unsupported/sandbox (`parked`, terminal).
 * The `onSchedule` reprocess sweep re-drives `failed` docs and deletes them on
 * success — same lifecycle as the ML log.
 *
 * SECURITY: Mercado Pago notifications are not reliably signed, so the
 * receiver must re-fetch the full payment from the MP API (using the linked
 * account's token, #530) before mutating anything — never trust the webhook
 * body alone. This schema only stores the webhook's own pointer fields for
 * dead-lettering / reprocessing; the verified payment shape is
 * `mpPaymentSchema` (`@delfrance/integrations-mercado-pago`).
 *
 * Field naming departs from the ML mirror in one place: MP's `data.id` is
 * already the bare payment id (not a URL-shaped resource path like ML's
 * `resource`), so there is no `notificacaoResourceId`-style helper here — the
 * field is stored directly as `paymentId`.
 *
 * Admin-only / default-deny: NOT registered in `ALL_DOMAINS` (like
 * `credenciaisMetodoPgto` / `notificacaoMercadoLivre`), so clients can't read
 * it and the rules generator emits no match block. The receiver
 * (apps/mercado-pago, Admin SDK) and its nested Cloud Functions are the only
 * writers/readers.
 */

/**
 * Local processing state (NOT an MP field). Only these two are ever
 * persisted — a successfully processed notification writes NOTHING (the cost
 * win, mirrors ML). `failed` is re-driven by the sweep; `parked` is terminal
 * (sandbox event, unsupported topic, or a `failed` doc that hit the reprocess
 * cap).
 */
export const notificacaoMercadoPagoStatusSchema = z.enum(['failed', 'parked']);
export type NotificacaoMercadoPagoStatus = z.infer<typeof notificacaoMercadoPagoStatusSchema>;

export const notificacaoMercadoPagoSchema = z
  .object({
    /**
     * The MP notification id (top-level `id` on the webhook body) —
     * normally also the Firestore doc id (the persister keys the failure doc
     * by it). Null on the rare body with no id, where an auto doc id is
     * minted instead.
     */
    id: z.string().nullable().default(null),
    /** The MP payment id (`data.id` on the webhook body). */
    paymentId: z.string().min(1),
    /** Event topic — MP's `type` (current Webhooks) or `topic` (legacy IPN). */
    topic: z.string().min(1),
    /**
     * The webhook's top-level `user_id` — resolves the owning `metodo_pgto`
     * account via its denormalized `user_id` (equality query, mirrors
     * `integracaoSchema.user_id`). NOT proof of the actual payment collector
     * — the receiver still verifies by re-fetching the payment before
     * trusting it (#531 security requirement).
     */
    collectorUserId: z.number().int().nullable().default(null),
    /** MP's `live_mode` — sandbox (`false`) events are dropped, not persisted. */
    liveMode: z.boolean().nullable().default(null),
    /** MP's `date_created` on the notification — tolerant of ISO-8601 or epoch millis. */
    dateCreated: millisSinceEpoch().nullable().default(null),

    // ---- Local resilience fields (new-app, not on the MP wire) ------------
    status: notificacaoMercadoPagoStatusSchema.default('failed'),
    /** LOCAL reprocess counter (incremented by the sweep). */
    tentativas: z.number().int().default(0),
    erro: z.string().nullable().default(null),
    /** Last-attempt time — the sweep's `processedAt < now-1h` window gate. */
    processedAt: millisSinceEpoch().nullable().default(null),
  })
  .passthrough();

export type NotificacaoMercadoPago = z.infer<typeof notificacaoMercadoPagoSchema>;
