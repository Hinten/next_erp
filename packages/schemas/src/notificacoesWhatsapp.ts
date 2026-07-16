import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/**
 * `notificacoesWhatsapp` (TOP-LEVEL) — the **failures-only** inbound webhook
 * log for WhatsApp Cloud API notifications (#527). Mirrors
 * `notificacaoMercadoPagoSchema` closely: Meta POSTs an `entry[].changes[]`
 * array, each change carrying a `field` (`messages`, `statuses`,
 * `message_template_status_update`, ...) that decides how the queue consumer
 * dispatches it; the receiver acks 200 fast (~250ms budget) by enqueuing the
 * raw body onto a Cloud Tasks queue (legacy `distribuidorWhastappCloudApi`)
 * — **without writing Firestore on the happy path**. A document is
 * persisted here ONLY when a change cannot be processed: the task handler
 * exhausted its retries (`failed`), or the `phoneNumberId` has no linked
 * `Conta_Whatsapp`/`integracao` yet (`failed`, sweep re-drives). `parked` is
 * set only by the sweep's own retry cap (`MAX_TENTATIVAS` exceeded — terminal).
 * Unsupported fields and undecodable payloads are DROPPED with a log and leave
 * no doc here (deterministic non-failures, mirroring the MP/ML pipelines). The
 * `onSchedule` reprocess sweep re-drives `failed` docs and deletes them on
 * success — same lifecycle as the MP/ML logs.
 *
 * Unlike MP/ML there is no single notification id on the WA wire itself —
 * the persister keys the failure doc by `messageId` when the change carries
 * one (a `messages`/`statuses` change), else an auto doc id is minted.
 *
 * Field naming departs from the MP/ML mirrors: WhatsApp's dispatch key is
 * `changes[].field` (not `type`/`topic`/`resource`), stored directly as
 * `field`. `phoneNumberId` (from `changes[].value.metadata.phone_number_id`)
 * resolves the owning `Conta_Whatsapp`/`integracao` (equality query, #528).
 * `messageId` (from `changes[].value.messages[].id` /
 * `changes[].value.statuses[].id`) is the Meta message id the change is
 * about, when applicable — absent on changes with no single message subject
 * (e.g. account review / template status updates).
 *
 * SECURITY: unlike the MP log (pointer fields only — MP content is re-FETCHED
 * from the API on reprocess), WhatsApp has no re-fetch anchor: the message
 * content exists only in the webhook body, so a failure doc also CARRIES the
 * raw change `value` (rides the `.passthrough()`) for the sweep to replay.
 * That value was signature-verified (`X-Hub-Signature-256`) by the receiver
 * before enqueueing/persisting, and the sweep re-parses it against
 * `valuePayloadSchema` before processing. The collection is admin-only /
 * default-deny (below), so no client can ever read the replayed payload.
 *
 * Admin-only / default-deny: bare `{ schema, meta }` (perms `0n`), NOT
 * registered in `ALL_DOMAINS` (like `credenciaisWhatsapp` /
 * `notificacaoMercadoPago`), so clients can't read it and the rules
 * generator emits no match block. The receiver (apps/whatsapp, Admin SDK)
 * and its nested Cloud Functions are the only writers/readers.
 */

/**
 * Local processing state (NOT a WA field). Only these two are ever
 * persisted — a successfully processed change writes NOTHING (the cost win,
 * mirrors MP/ML). `failed` is re-driven by the sweep; `parked` is terminal
 * (unsupported field, or a `failed` doc that hit the reprocess cap).
 */
export const notificacoesWhatsappStatusSchema = z.enum(['failed', 'parked']);
export type NotificacoesWhatsappStatus = z.infer<typeof notificacoesWhatsappStatusSchema>;

export const notificacoesWhatsappSchema = z
  .object({
    /** WA dispatch key — `changes[].field` (`messages`, `statuses`, ...). */
    field: z.string().min(1),
    /**
     * `changes[].value.metadata.phone_number_id` — resolves the owning
     * `Conta_Whatsapp`/`integracao` (equality query, #528). Null when the
     * change carries no `metadata` block.
     */
    phoneNumberId: z.string().nullable().default(null),
    /**
     * The Meta message id the change is about (`value.messages[].id` /
     * `value.statuses[].id`), when applicable — normally also the Firestore
     * doc id (the persister keys the failure doc by it). Null on changes
     * with no single message subject, where an auto doc id is minted
     * instead.
     */
    messageId: z.string().nullable().default(null),

    // ---- Local resilience fields (new-app, not on the WA wire) ------------
    status: notificacoesWhatsappStatusSchema.default('failed'),
    /** LOCAL reprocess counter (incremented by the sweep). */
    tentativas: z.number().int().default(0),
    erro: z.string().nullable().default(null),
    /** Last-attempt time — the sweep's `processedAt < now-1h` window gate. */
    processedAt: millisSinceEpoch().nullable().default(null),
  })
  .passthrough();

export type NotificacoesWhatsapp = z.infer<typeof notificacoesWhatsappSchema>;

export const notificacoesWhatsappMeta: CollectionMetadata = {
  collectionPath: 'notificacoesWhatsapp',
  // No client domain grants these bits — placeholder values. Deliberately
  // NOT registered in `ALL_DOMAINS`, so the rules generator emits no match
  // block and Firestore default-denies every client read/write. Only the
  // Admin SDK (apps/whatsapp) reaches it. Mirrors `credenciaisWhatsappMeta`.
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
// shape never gets swept in by accident (mirrors `credenciaisWhatsappSchema`
// / `credenciaisWhatsappMeta`). The admin collection handle
// (`notificacoesWhatsappCollection`) consumes `notificacoesWhatsappMeta.collectionPath`
// directly.
