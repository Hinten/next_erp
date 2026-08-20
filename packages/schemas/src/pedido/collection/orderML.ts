import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { millisSinceEpoch } from '../../shared/datetime';
import { outerRefSchema } from '../../shared/outerRef';

// Shares the PEDIDO permission domain: `orderML` is a marketplace mirror of
// the parent order (one doc per ML order, living under `pedidos/{pedidoId}`)
// — the same "audit-adjacent child of the pedido" rationale
// `historicoEstadoPedidoMeta` already uses for its read/write/delete reuse.
const PERM_PEDIDO_READ = 1n << 16n;
const PERM_PEDIDO_WRITE = 1n << 17n;
const PERM_PEDIDO_DELETE = 1n << 18n;

/**
 * `orderML` — subcoleção `pedidos/{pedidoId}/orderML`, one doc per Mercado
 * Livre order feeding that pedido (a pack pedido holds several: doc id is
 * `String(order.id)`). Byte-for-byte mirror of the legacy Flutter `OrderML`
 * wire (`.old/packages/canais_de_venda/mercado_livre/lib/src/models.g.dart`
 * 638–676) because the migrated corpus is stored in exactly that shape and has
 * to be read and written the same way (same rationale as
 * `produtoMercadoLivreLinkSchema`).
 *
 * This schema is READ-tolerant only — a plain `z.string()` `status` (not a
 * strict enum) and passthrough on every nested/opaque block. Byte-exact WRITE
 * parity (which keys are omitted vs. written-as-null) is
 * `buildOrderMLWire`'s job (`apps/mercado-livre/lib/marketplace/orderMLWire.ts`),
 * not this schema's — mirrors how `produtoMercadoLivreLinkSchema` leaves wire
 * parity to its own writer.
 *
 * Wire notes (from the generated Dart serializer + the legacy field list):
 *  - `id`, `contaMercadoLivreOuterRef`, `status`, the date fields, and
 *    `order_items`/`payments`/`buyer`/`pack_id`/`pickup_id`/`buying_mode`/
 *    `shipping_cost`/`total_amount`/`paid_amount`/`coupon`/`shipping` are
 *    ALWAYS written by Flutter, even when the value is `null`
 *    (`includeIfNull: true`);
 *  - `status_detail`, `tags` and `comment` are OMITTED from the wire when
 *    `null` — hence `.nullable().optional()` (never written as an explicit
 *    `null`, but tolerated on read for a doc written by a different path);
 *  - date fields serialize as epoch **milliseconds** — unlike the rest of
 *    this package (µs, the project standard for pedido/pagamento/frete
 *    fields), this mirror doc deliberately stays on the legacy wire unit so a
 *    byte-diff against Flutter's write stays trivial (approved deviation,
 *    see the pedido/pagamento fields' µs convention in `./pedido.ts`).
 */

/** Raw ML order-item wire entry (`order.order_items[]`). Tolerant pass-through. */
const orderMLItemWireSchema = z.object({}).passthrough();

/** Raw ML payment-summary wire entry (`order.payments[]`). Tolerant pass-through. */
const orderMLPaymentWireSchema = z.object({}).passthrough();

export const orderMLSchema = z
  .object({
    /** ML order id (also the doc id, stringified: `String(order.id)`). */
    id: z.number(),
    /** Canonical `documents/integracao/<contaId>` path to the owning conta. */
    contaMercadoLivreOuterRef: outerRefSchema,
    /**
     * Raw ML order `status` — one of `confirmed`, `payment_required`,
     * `payment_in_process`, `partially_paid`, `paid`, `partially_refunded`,
     * `pending_cancel`, `cancelled`, `invalid`. Kept a plain string (not a
     * strict enum) so an ML-added status never fails the read; the estado
     * mapping lives in `estadoPedidoFromOrderStatus`
     * (`apps/mercado-livre/lib/marketplace/orderStatusMaps.ts`).
     */
    status: z.string(),
    status_detail: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    comment: z.string().nullable().optional(),

    date_created: millisSinceEpoch('Criado em').nullable().default(null),
    date_closed: millisSinceEpoch('Fechado em').nullable().default(null),
    last_updated: millisSinceEpoch('Última atualização').nullable().default(null),
    expiration_date: millisSinceEpoch('Expira em').nullable().default(null),
    manufacturing_ending_date: millisSinceEpoch('Prazo de fabricação').nullable().default(null),

    order_items: z.array(orderMLItemWireSchema).nullable().default(null),
    payments: z.array(orderMLPaymentWireSchema).nullable().default(null),
    buyer: z.object({}).passthrough().nullable().default(null),

    pack_id: z.number().nullable().default(null),
    pickup_id: z.number().nullable().default(null),
    buying_mode: z.string().nullable().default(null),

    shipping_cost: z.number().nullable().default(null),
    total_amount: z.number().nullable().default(null),
    paid_amount: z.number().nullable().default(null),

    coupon: z.object({}).passthrough().nullable().default(null),
    shipping: z.object({ id: z.number().nullish() }).passthrough().nullable().default(null),
  })
  .passthrough();

export type OrderML = z.infer<typeof orderMLSchema>;

export const orderMLMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/orderML',
  permissions: {
    // Legacy gave this its own perm code (`ma`), independently grantable to
    // whichever roles need marketplace order visibility; we fold that into
    // the PEDIDO domain instead (same simplification
    // `historicoEstadoPedidoMeta` already made) — anyone who can read the
    // parent pedido can read its ML order mirror. Write/delete reuse the
    // PEDIDO bits too: the generator requires a single positive PERM bit per
    // action (0n fails generation), and in practice both writers (the ML
    // order-import path and status-sync, `apps/mercado-livre`) use the Admin
    // SDK, which bypasses rules — the client-side bits exist for rule
    // validity, not because any client flow writes these docs.
    read: PERM_PEDIDO_READ,
    write: PERM_PEDIDO_WRITE,
    delete: PERM_PEDIDO_DELETE,
  },
};

export const orderML = { schema: orderMLSchema, meta: orderMLMeta };
