import { z } from 'zod';
import { millisSinceEpoch } from './datetime';

/**
 * The four LOCAL resilience fields every failures-only inbound-webhook
 * notification collection carries — `notificacaoMercadoLivre`,
 * `notificacaoMercadoPago`, `notificacoesWhatsapp`, and any channel added
 * later.
 *
 * None of them are on any provider's wire. They are written and read BLIND by
 * the shared pipeline in `@delfrance/data/admin/notifications`
 * (`defineNotificationPipeline`), which queries `status == 'failed' &&
 * processedAt < cutoff` and merges `{status, tentativas, erro, processedAt}`
 * without knowing which channel it is serving. That coupling is the reason
 * these live in one place: renaming a field in a channel schema alone would not
 * fail typecheck — it would fail at 3am, in a sweep, in production.
 *
 * Exported as a FUNCTION returning fresh builders (mirroring `millisSinceEpoch()`),
 * spread into each channel's object:
 *
 * ```ts
 * export const notificacaoXSchema = z
 *   .object({ ...wireFields, ...notificationResilienceFields() })
 *   .passthrough();
 * ```
 *
 * ⚠️ This module must NEVER export a value carrying both a `.schema` and a
 * `.meta` property. `registry.test.ts`'s `isDomainSchema()` sweeps the barrel
 * for that shape, and these collections are deliberately admin-only /
 * default-deny: absent from `ALL_DOMAINS`, so the rules generator emits no match
 * block and Firestore denies every client read. A plain function is
 * `typeof 'function'`, which the guard rejects on its first line — see the NOTE
 * at the bottom of `notificacoesWhatsapp.ts`.
 */

/**
 * Local processing state. Only these two are ever persisted — a successfully
 * processed notification writes NOTHING (the cost win). `failed` is re-driven by
 * the sweep; `parked` is terminal (an unsupported event, or a `failed` doc that
 * hit the reprocess cap).
 */
export const notificacaoResilienciaStatusSchema = z.enum(['failed', 'parked']);
export type NotificacaoResilienciaStatus = z.infer<typeof notificacaoResilienciaStatusSchema>;

/**
 * Named members of {@link notificacaoResilienciaStatusSchema}. One constant
 * covers every channel: `notificacaoStatusSchema` and its Mercado Pago /
 * WhatsApp siblings are all aliases of the schema above, and each channel's
 * `status` field comes from the shared {@link notificationResilienceFields}, so
 * the enum a literal is resolved against is this one wherever it appears.
 *
 * Enforced by the `delfrance/prefer-schema-enum` lint rule, which fires for any
 * Zod enum that has a companion constant like this one.
 */
export const NOTIFICACAO_RESILIENCIA_STATUS = {
  failed: 'failed',
  parked: 'parked',
} as const satisfies Record<string, NotificacaoResilienciaStatus>;

export function notificationResilienceFields() {
  return {
    status: notificacaoResilienciaStatusSchema.default(NOTIFICACAO_RESILIENCIA_STATUS.failed),
    /** LOCAL reprocess counter (incremented by the sweep). */
    tentativas: z.number().int().default(0),
    erro: z.string().nullable().default(null),
    /**
     * Last-attempt time — the sweep's `processedAt < now-1h` window gate, and
     * its durable cursor: re-stamped on every attempt, so a doc that keeps
     * failing slides to the back of the queue instead of starving the backlog.
     */
    processedAt: millisSinceEpoch().nullable().default(null),
  };
}
