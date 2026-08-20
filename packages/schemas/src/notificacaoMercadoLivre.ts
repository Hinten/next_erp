import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';
import {
  notificacaoResilienciaStatusSchema,
  notificationResilienceFields,
} from './shared/notificationResilience';

// Mirror `PERM.integracao` from @delfrance/auth (duplicated locally to avoid a
// circular dep — same approach as cargo.ts / deposito.ts).
const PERM_INTEGRACAO_READ = 1n << 56n;
const PERM_INTEGRACAO_WRITE = 1n << 57n;
const PERM_INTEGRACAO_DELETE = 1n << 58n;

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
 * (models.dart:349, same collection), which is how the migrated corpus is
 * stored; the legacy app likewise only stored a doc on a processing error.
 *
 * Local resilience fields the legacy wire shape never had: `status`, a LOCAL
 * retry counter `tentativas` (distinct from ML's own delivery `attempts`),
 * `erro`, and `processedAt` (the last-attempt time — the sweep's window gate).
 *
 * ⚠️ **LEGACY-PARITY registration — remove with the Flutter decommission (#829).**
 * The new app reaches this collection only through the Admin SDK (the receiver
 * route and the nested functions), which bypasses rules, so on its own merits it
 * would stay unregistered and default-denied like its Mercado Pago and WhatsApp
 * siblings. It is registered in `ALL_DOMAINS` purely for literal parity with the
 * legacy ruleset (`match /notificacoesMercadoLivre`, perm code `m4`,
 * `.old/firestore.rules:186-191`), so that deploying the generated ruleset
 * cannot deny the legacy Flutter app anything it has today. ⚠️ That parity buys
 * this app nothing — there is no dual run (root `CLAUDE.md` rule 8), so the
 * registration is surface #829 removes. Registration also
 * required a carve-out in `shared/notificationResilience.test.ts`, whose blanket
 * guard otherwise forbids any `notificac*` path in `ALL_DOMAINS` — that guard
 * still bites for Mercado Pago and WhatsApp. See #783.
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
     * id (the persister keys the failure doc by it). Null whenever ML sent no
     * id: on the rare body carrying neither key, on a `missed_feeds` entry
     * without `_id`, and on every notification the order-backfill sweep
     * synthesises. In those cases the doc id is DERIVED from `topic` + `resource`
     * (`docIdOf` in `apps/mercado-livre/lib/marketplace/notificacao.ts`, #807) so
     * repeated failures still converge on one document — this field stays null
     * rather than carrying the derived value, because it is not an ML id.
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

export const notificacaoMercadoLivreMeta: CollectionMetadata = {
  collectionPath: 'notificacoesMercadoLivre',
  // LEGACY-CLIENT grant (#829) — see the docstring above. Legacy perm `m4`;
  // reusing the `integracao` bits keeps existing claim-holders working, exactly
  // as `brandShopee` does.
  permissions: {
    read: PERM_INTEGRACAO_READ,
    write: PERM_INTEGRACAO_WRITE,
    delete: PERM_INTEGRACAO_DELETE,
  },
};

export const notificacaoMercadoLivre = {
  schema: notificacaoMercadoLivreSchema,
  meta: notificacaoMercadoLivreMeta,
};

/** The `resource_id` — last path segment of `resource` (old computed getter). */
export function notificacaoResourceId(resource: string): string {
  const segs = resource.split('/').filter(Boolean);
  return segs[segs.length - 1] ?? resource;
}
