import { z } from 'zod';

/**
 * Subset of the WhatsApp Cloud API webhook payload we consume today.
 * Reference:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *
 * Pass-through `.passthrough()` so unfamiliar fields (sticker, location,
 * order, etc.) round-trip without breaking parse.
 */

/**
 * The only `changes[].field` value the dispatcher (#527) currently acts on.
 * `webhookEnvelopeSchema` accepts any string field (WhatsApp Business
 * Management webhooks reuse the same envelope shape with other field
 * values), so the dispatcher switches on this constant rather than relying
 * on the schema to reject unknown fields.
 */
export const WEBHOOK_FIELD_MESSAGES = 'messages' as const;

export const wamediaSchema = z
  .object({
    id: z.string(),
    mime_type: z.string().optional(),
    sha256: z.string().optional(),
    filename: z.string().optional(),
    caption: z.string().optional(),
  })
  .passthrough();

/**
 * `messages[].reaction` — emoji reaction to a prior message.
 */
export const reactionSchema = z
  .object({
    message_id: z.string().nullish(),
    emoji: z.string().nullish(),
  })
  .passthrough();

/**
 * `messages[].referral` — ad/post click-to-WhatsApp context. Field names
 * mirror `mensagemSchema.referral` in `packages/schemas/src/conversa.ts` so
 * the dispatcher can pass this through without renaming keys.
 */
export const referralSchema = z
  .object({
    source_url: z.string().nullish(),
    source_type: z.string().nullish(),
    source_id: z.string().nullish(),
    headline: z.string().nullish(),
    body: z.string().nullish(),
    media_type: z.string().nullish(),
    image_url: z.string().nullish(),
    video_url: z.string().nullish(),
    thumbnail_url: z.string().nullish(),
    ctwa_clid: z.string().nullish(),
  })
  .passthrough();

/**
 * `messages[].interactive` — button/list reply. Shape varies by
 * `interactive.type` (`button_reply` vs `list_reply`); stay tolerant
 * rather than modeling every variant.
 */
export const interactiveSchema = z.object({}).passthrough();

/**
 * `messages[].button` — quick-reply tap on a legacy template button.
 */
export const buttonSchema = z
  .object({
    text: z.string().nullish(),
    payload: z.string().nullish(),
  })
  .passthrough();

/** `messages[].location` — tolerant; not consumed by this package yet. */
export const locationSchema = z.object({}).passthrough();

/** `messages[].order` — tolerant; not consumed by this package yet. */
export const orderSchema = z.object({}).passthrough();

/**
 * `messages[].errors` — per-message delivery/processing errors, distinct
 * from the top-level `value.errors` and `statuses[].errors`.
 */
export const messageErrorSchema = z
  .object({
    code: z.number(),
    title: z.string().nullish(),
    message: z.string().nullish(),
    error_data: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

export const incomingMessageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string(),
    /**
     * ⚠️ A plain string, NOT an enum, and that is load-bearing rather than lazy.
     *
     * Nothing reads this field: `tipoMensagem` derives the mensagem kind from
     * WHICH media key is present (`processMessages.ts` — `message.audio` →
     * audio, `message.image ?? .document ?? .sticker` → arquivo, else comum),
     * never from `type`. So a closed enum here buys nothing and costs the whole
     * delivery: Meta adds message types (this list is a snapshot), an unlisted
     * one fails the element, a Zod array fails as a WHOLE when any element
     * fails, and the failure propagates up `valuePayloadSchema` →
     * `webhookEnvelopeSchema` → `parseWebhookBody`, which returns null and takes
     * every other change in the POST with it. Legacy typed it `String` too.
     *
     * The documented values are text · image · video · audio · document ·
     * sticker · reaction · button · interactive · location · contacts · order ·
     * system · unknown — kept here as prose so the list can never reject one.
     */
    type: z.string().min(1),
    text: z.object({ body: z.string() }).optional(),
    image: wamediaSchema.optional(),
    video: wamediaSchema.optional(),
    audio: wamediaSchema.optional(),
    document: wamediaSchema.optional(),
    sticker: wamediaSchema.optional(),
    reaction: reactionSchema.nullish(),
    referral: referralSchema.nullish(),
    interactive: interactiveSchema.nullish(),
    button: buttonSchema.nullish(),
    location: locationSchema.nullish(),
    order: orderSchema.nullish(),
    errors: z.array(messageErrorSchema).nullish(),
    context: z
      .object({
        from: z.string().optional(),
        id: z.string().optional(),
        forwarded: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

/**
 * The `statuses[].status` values this pipeline KNOWS how to advance a mensagem
 * with. A snapshot of Meta's documented set — deliberately NOT the wire type.
 */
export const WA_STATUS_KNOWN = ['sent', 'delivered', 'read', 'failed', 'deleted'] as const;

/** A `status` Meta shipped after {@link WA_STATUS_KNOWN} was written. */
export const WA_STATUS_DESCONHECIDO = 'desconhecido';

export type WaKnownStatus = (typeof WA_STATUS_KNOWN)[number];
export type WaStatus = WaKnownStatus | typeof WA_STATUS_DESCONHECIDO;

/**
 * Fold a raw wire `status` onto the closed set the processor switches over.
 *
 * ⚠️ Pure, total, and EXACT — no trimming, no case folding. `'Sent'` and
 * `'sent '` are NOT `'sent'`; they fold to `desconhecido`, which is the honest
 * answer, and the near-miss tests pin exactly that. Meta sends lowercase
 * tokens, so a case-insensitive match would only ever paper over a value we do
 * not actually understand — and quietly mapping an unknown token onto a known
 * one writes the WRONG `estadoEnvio` instead of the honest `desconhecido`.
 *
 * The narrowing lives HERE rather than in the schema (as
 * `z.enum(...).catch(WA_STATUS_DESCONHECIDO)`) for one reason: `.catch()`
 * ERASES the raw string, and that string — the name of the value Meta just
 * added — is the single most useful thing an operator can be told. The schema
 * keeps it; this folds it only at the point of use, which also keeps
 * `status` a LITERAL UNION at both switches in `processStatus.ts`, so
 * `switch-exhaustiveness-check` still covers them.
 */
export function narrowWaStatus(raw: string): WaStatus {
  return (WA_STATUS_KNOWN as readonly string[]).includes(raw)
    ? (raw as WaKnownStatus)
    : WA_STATUS_DESCONHECIDO;
}

export const statusUpdateSchema = z
  .object({
    id: z.string(),
    recipient_id: z.string(),
    /**
     * ⚠️ The RAW wire string, NOT `z.enum(WA_STATUS_KNOWN)` — narrowed at the
     * point of use by {@link narrowWaStatus}.
     *
     * As an enum this was the single most expensive field in the package: Meta
     * has added `status` values before, a Zod array fails as a WHOLE when any
     * element fails, and this schema is embedded transitively in the RECEIVER's
     * envelope parse. So one unrecognised status made `parseWebhookBody` return
     * null and the route ack 200 — dropping every `entry[]`, every `changes[]`
     * and any customer `messages[]` riding in the same POST, with no Cloud
     * Task, no failure document and no log line at all. Meta saw a 200 and
     * never retried. Legacy typed it `final String` for exactly this reason.
     */
    status: z.string().min(1),
    timestamp: z.string(),
    errors: z
      .array(
        z
          .object({
            code: z.number(),
            title: z.string().optional(),
            message: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const valuePayloadSchema = z
  .object({
    messaging_product: z.literal('whatsapp'),
    metadata: z.object({
      display_phone_number: z.string(),
      phone_number_id: z.string(),
    }),
    contacts: z
      .array(
        z
          .object({
            profile: z.object({ name: z.string() }).optional(),
            wa_id: z.string(),
          })
          .passthrough(),
      )
      .optional(),
    /**
     * ⚠️ `(IncomingMessage | null)[]` — element-tolerant, and the nulls are KEPT
     * rather than filtered out.
     *
     * A Zod array fails as a WHOLE when any element fails, so a single
     * malformed message used to discard its good siblings AND the `statuses[]`
     * beside them. `.nullable().catch(null)` scopes the failure to the one
     * element it belongs to.
     *
     * They are kept rather than filtered because TOLERANCE MUST NEVER BE
     * SILENT: `processMessagesField` counts the nulls into
     * `MensagensReport.malformados`, which rides out to the task log. A
     * `.filter()` here would fix the data loss and hide it in the same line.
     */
    messages: z.array(incomingMessageSchema.nullable().catch(null)).optional(),
    /** Same contract as `messages` above; counted into `StatusesReport.malformados`. */
    statuses: z.array(statusUpdateSchema.nullable().catch(null)).optional(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * The webhook envelope, and ONLY the envelope — a structural skeleton.
 *
 * ⚠️ `value` is `z.unknown()` ON PURPOSE. It used to be `valuePayloadSchema`,
 * and that single line was the defect: the RECEIVER validated far more than it
 * reads. `parseWebhookBody` touches `object`, `entry[].id`, `changes[].field`
 * and three already-optional-chained strings, then enqueues a payload typed
 * `value: unknown` which `processMessagesField` re-parses against
 * `valuePayloadSchema` anyway. Demanding the full value HERE bought nothing and
 * cost the whole delivery, because a parse failure at the receiver returns null
 * and the route acks 200 — no task, no failure doc, no log line.
 *
 * Two shapes hit that, and both are real:
 *
 *  1. an unrecognised `statuses[].status` or `messages[].type` (now widened
 *     above, but the array-wide failure mode is structural, not enum-specific);
 *  2. EVERY non-`messages` field. `field` was kept a plain string precisely so
 *     WhatsApp Business Management events parse — but `value` still demanded
 *     `messaging_product: 'whatsapp'` plus `metadata.{display_phone_number,
 *     phone_number_id}`, and those events carry NEITHER. Legacy modelled
 *     `message_template_status_update`'s value as
 *     `{event, message_template_id, message_template_name,
 *     message_template_language, reason, …}` — no metadata anywhere. So the
 *     tolerance the old comment claimed did not exist: the envelope rejected
 *     those events, the dispatcher never saw the field, and
 *     `DropOutcome.'campo-nao-suportado'` was DEAD CODE in production.
 *
 * Legacy did exactly what this does now — `WebhookChangeGeneric.value` is
 * `dynamic`, and only the `messages` change binds the metadata-bearing value
 * type. The port collapsed every field onto one required shape; this undoes it.
 *
 * The structure that REMAINS is what actually distinguishes a WhatsApp webhook
 * from an arbitrary POST body, so a non-envelope body still parses to null.
 */
export const webhookEnvelopeSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          // WhatsApp Business Management webhooks reuse this same envelope with
          // other `field` values (`account_update`,
          // `phone_number_quality_update`, `message_template_status_update`, …);
          // only `WEBHOOK_FIELD_MESSAGES` is dispatched, and the rest are
          // dropped — with a LOG — one layer down in `processChangePayload`.
          field: z.string(),
          value: z.unknown(),
        }),
      ),
    }),
  ),
});

/**
 * Response body of `GET /{media-id}` — resolves a media id to a short-lived
 * download URL. Reference:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#retrieve-media-url
 *
 * Mirrors legacy `GetMedia` (`.old/packages/canais_de_venda/whatsapp_cloud_api/lib/src/api_v23/media.dart`).
 * `sha256`/`file_size` are marked optional here even though the documented
 * payload always includes them — tolerant parsing so an API change that
 * drops a field degrades to `undefined` instead of throwing.
 */
export const mediaMetadataSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    mime_type: z.string(),
    sha256: z.string().optional(),
    file_size: z.number().optional(),
  })
  .passthrough();

export type MediaMetadata = z.infer<typeof mediaMetadataSchema>;

/**
 * Response body of `GET /{phoneNumberId}?fields=status,quality_rating,
 * code_verification_status,display_phone_number,verified_name,throughput` —
 * the phone-number node used by the account-health surface. Reference:
 * https://developers.facebook.com/docs/graph-api/reference/whats-app-business-phone-number
 *
 * Every field is nullable-tolerant and the enum-ish fields (`status`,
 * `quality_rating`, `code_verification_status`) are typed as plain strings so
 * an unknown/new Graph enum value passes through verbatim instead of throwing.
 * Documented values today: `status` ∈ CONNECTED / PENDING / MIGRATED / BANNED /
 * RESTRICTED / RATE_LIMITED / FLAGGED / DISCONNECTED / DELETED / ...;
 * `quality_rating` ∈ GREEN / YELLOW / RED / UNKNOWN / NA;
 * `code_verification_status` ∈ VERIFIED / NOT_VERIFIED / EXPIRED.
 */
export const phoneNumberStatusSchema = z
  .object({
    id: z.string().nullish(),
    status: z.string().nullish(),
    quality_rating: z.string().nullish(),
    code_verification_status: z.string().nullish(),
    display_phone_number: z.string().nullish(),
    verified_name: z.string().nullish(),
    throughput: z.object({ level: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

export type PhoneNumberStatus = z.infer<typeof phoneNumberStatusSchema>;

/**
 * One entry of `GET /{wabaId}/subscribed_apps` — the app subscribed to the
 * WhatsApp Business Account's webhooks. Reference:
 * https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/subscribed_apps
 * Tolerant: only `whatsapp_business_api_data.name` is consumed (for the health
 * check's "which app" detail); everything else rides `.passthrough()`.
 */
export const subscribedAppSchema = z
  .object({
    whatsapp_business_api_data: z
      .object({
        id: z.string().nullish(),
        name: z.string().nullish(),
        link: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type SubscribedApp = z.infer<typeof subscribedAppSchema>;

/** Envelope of `GET /{wabaId}/subscribed_apps` — `{ data: SubscribedApp[] }`. */
export const subscribedAppsResponseSchema = z
  .object({
    data: z.array(subscribedAppSchema).nullish(),
  })
  .passthrough();

export type SubscribedAppsResponse = z.infer<typeof subscribedAppsResponseSchema>;

export type IncomingMessage = z.infer<typeof incomingMessageSchema>;
export type StatusUpdate = z.infer<typeof statusUpdateSchema>;
export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;
export type Reaction = z.infer<typeof reactionSchema>;
export type Referral = z.infer<typeof referralSchema>;
export type Interactive = z.infer<typeof interactiveSchema>;
export type ButtonReply = z.infer<typeof buttonSchema>;
export type Location = z.infer<typeof locationSchema>;
export type Order = z.infer<typeof orderSchema>;
export type MessageError = z.infer<typeof messageErrorSchema>;
