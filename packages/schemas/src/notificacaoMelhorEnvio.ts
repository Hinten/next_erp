import { z } from 'zod';
import {
  notificacaoResilienciaStatusSchema,
  notificationResilienceFields,
} from './shared/notificationResilience';

/**
 * Failures-only log for Melhor Envio order-status notifications (#681).
 *
 * The provider's `data.status` is stored as `providerStatus`: the plain
 * `status` key belongs to the shared notification pipeline and identifies its
 * `failed` / `deferred` / `parked` lane. A successfully processed delivery
 * writes no document.
 *
 * Admin-only / default-deny: this is a bare schema, deliberately absent from
 * `ALL_DOMAINS`, so the rules generator emits no client-access block.
 */
export const notificacaoMelhorEnvioStatusSchema = notificacaoResilienciaStatusSchema;
export type NotificacaoMelhorEnvioStatus = z.infer<typeof notificacaoMelhorEnvioStatusSchema>;

export const notificacaoMelhorEnvioSchema = z
  .object({
    /** Melhor Envio label/order id (`data.id`). */
    labelId: z.string().nullable().default(null),
    /** Provider event name, for example `order.posted`. */
    event: z.string().nullable().default(null),
    /** Provider `data.status`; separate from the local pipeline `status`. */
    providerStatus: z.string().nullable().default(null),
    /** Provider tracking code when present. */
    tracking: z.string().nullable().default(null),

    ...notificationResilienceFields(),
  })
  .passthrough();

export type NotificacaoMelhorEnvio = z.infer<typeof notificacaoMelhorEnvioSchema>;
