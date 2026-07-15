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
    type: z.enum([
      'text',
      'image',
      'video',
      'audio',
      'document',
      'sticker',
      'reaction',
      'button',
      'interactive',
      'location',
      'contacts',
      'order',
      'system',
      'unknown',
    ]),
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

export const statusUpdateSchema = z
  .object({
    id: z.string(),
    recipient_id: z.string(),
    status: z.enum(['sent', 'delivered', 'read', 'failed', 'deleted']),
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
    messages: z.array(incomingMessageSchema).optional(),
    statuses: z.array(statusUpdateSchema).optional(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const webhookEnvelopeSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          // WhatsApp Business Management webhooks reuse this same envelope
          // with other `field` values (e.g. `account_update`,
          // `phone_number_quality_update`); only `WEBHOOK_FIELD_MESSAGES`
          // is dispatched today, but the schema stays a plain string so
          // it doesn't reject those other events at parse time.
          field: z.string(),
          value: valuePayloadSchema,
        }),
      ),
    }),
  ),
});

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
