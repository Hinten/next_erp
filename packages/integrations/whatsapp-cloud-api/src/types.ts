import { z } from 'zod';

/**
 * Subset of the WhatsApp Cloud API webhook payload we consume today.
 * Reference:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *
 * Pass-through `.passthrough()` so unfamiliar fields (sticker, location,
 * order, etc.) round-trip without breaking parse.
 */

export const wamediaSchema = z.object({
  id: z.string(),
  mime_type: z.string().optional(),
  sha256: z.string().optional(),
  filename: z.string().optional(),
  caption: z.string().optional(),
}).passthrough();

export const incomingMessageSchema = z.object({
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
  context: z
    .object({
      from: z.string().optional(),
      id: z.string().optional(),
      forwarded: z.boolean().optional(),
    })
    .optional(),
}).passthrough();

export const statusUpdateSchema = z.object({
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
}).passthrough();

export const valuePayloadSchema = z.object({
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
}).passthrough();

export const webhookEnvelopeSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          field: z.literal('messages'),
          value: valuePayloadSchema,
        }),
      ),
    }),
  ),
});

export type IncomingMessage = z.infer<typeof incomingMessageSchema>;
export type StatusUpdate = z.infer<typeof statusUpdateSchema>;
export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;
