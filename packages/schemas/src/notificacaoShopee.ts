import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import {
  notificacaoResilienciaStatusSchema,
  notificationResilienceFields,
} from './shared/notificationResilience';

/**
 * `notificacoesShopee` (TOP-LEVEL) — the **failures-only** inbound push log for
 * the Shopee Open Platform channel (step 3 of the Shopee master plan). Mirrors
 * `notificacaoMercadoPagoSchema`: the receiver verifies the `Authorization`
 * HMAC over the raw body, enqueues the lean payload onto the Cloud Tasks queue
 * and answers **204 with an empty body** — Shopee counts a `200 {"ok":true}` as
 * a FAILED push — **without writing Firestore on the happy path**. A document
 * lands here ONLY when a push cannot be processed: the enqueue itself failed,
 * the task handler exhausted its retries (`failed`), the push names a shop that
 * maps to no active integração yet (`deferred`, the daily lane re-drives), or
 * the push code has no handler yet (`parked`, terminal).
 *
 * Three Shopee-specific facts are baked into the field list:
 *
 *  - **`code` is the `push_code`, never the `push_api_id` that names the doc
 *    page.** `shop_authorization_push` is documented as `push_api_id=15` and
 *    arrives as `code: 1`; `order_status_push` is `push_api_id=1` and arrives as
 *    `code: 3`. Routing on the wrong number silently mis-dispatches.
 *  - **`shop_id` sits in different places per push** — top level on the order
 *    codes, inside `data` on the authorization ones, absent entirely on the
 *    partner-level expiry push (`code 12`). The receiver LIFTS whichever it
 *    finds (tolerating Shopee's own `shopid` misspelling) into this one field,
 *    so `null` here means "partner-level or unknown", not "the wire had none".
 *  - **`timestamp` is SECONDS on Shopee's wire and MILLIS here.** The receiver
 *    multiplies before coercing, so nothing downstream has to remember.
 *
 * `data` is kept verbatim (bounded and scalar-safe by the receiver) because
 * Shopee gives **no event id of any kind** — no message id, no delivery id — and
 * the resource key the handler re-fetches (`ordersn`, `item_id`,
 * `shop_expire_soon[]`) lives inside it. Dropping it would leave a dead-letter
 * row that names no work.
 *
 * Admin-only / default-deny: NOT registered in `ALL_DOMAINS` (like
 * `notificacaoMercadoPago` / `notificacoesWhatsapp`), so clients cannot read it
 * and the rules generator emits no match block. `apps/shopee` (Admin SDK) and
 * its nested Cloud Functions are the only writers/readers.
 */

/**
 * Local processing state — an alias of the SHARED
 * `notificacaoResilienciaStatusSchema` so the enum cannot drift from what the
 * pipeline in `@delfrance/data/admin/notifications` writes. Kept as a named
 * export because the barrel already publishes it.
 */
export const notificacaoShopeeStatusSchema = notificacaoResilienciaStatusSchema;
export type NotificacaoShopeeStatus = z.infer<typeof notificacaoShopeeStatusSchema>;

export const notificacaoShopeeSchema = z
  .object({
    /**
     * Shopee's `push_code` — the ONLY routing field. Never the `push_api_id`
     * from the documentation URL (see the module docblock).
     */
    code: z.number().int(),
    /**
     * The shop the push is about: read from the top level, or LIFTED out of
     * `data` (`shop_id` / `shopid`) by the receiver. Null for a partner-level
     * push such as `code 12`, and for a body that named no shop at all.
     */
    shop_id: z.number().int().nullable().default(null),
    /**
     * The envelope's own `timestamp`, already normalized to epoch MILLIS by the
     * receiver (Shopee sends SECONDS). Informational — the sweep gates on the
     * local `processedAt`, never on this.
     */
    timestamp: millisSinceEpoch().nullable().default(null),
    /**
     * The push's `data` object, bounded by the receiver. The only place the
     * resource key lives, since Shopee sends no event id.
     */
    data: z.record(z.string(), z.unknown()).nullable().default(null),

    // ---- Local resilience fields (shared; not on any provider's wire) -----
    // Written/read blind by the pipeline in `@delfrance/data/admin/notifications`.
    ...notificationResilienceFields(),
  })
  .passthrough();

export type NotificacaoShopee = z.infer<typeof notificacaoShopeeSchema>;
