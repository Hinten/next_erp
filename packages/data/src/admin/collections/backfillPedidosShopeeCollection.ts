import { backfillPedidosShopeeMeta, backfillPedidosShopeeSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `backfillPedidosShopee` per-conta cursor doc
 * (master-plan step 4, #1512) — the 15-minute Shopee order-backfill sweep
 * (apps/shopee nested functions) reads the high-water mark before paging
 * `get_order_list` and merges it forward only after the conta's window drained;
 * doc id = integracaoId.
 *
 * ⚠️ Its clocks are MILLISECONDS (`cursorMs`, `lastSweepAtMs`, the two
 * `pendingWindow*Ms` bounds), unlike the µs of
 * `backfillPedidosMercadoLivreCollection` — see the schema's header.
 *
 * The sweep is this document's ONLY writer and writes it with a single `merge`
 * per conta per tick, so root rule 7 is satisfied at tier 0 by construction and
 * the sweep runs no Firestore transaction at all — nothing for the transaction
 * inventory to classify. (Said WITHOUT the API's identifier on purpose: the
 * inventory guard greps every source file for that literal, and a comment-only
 * mention would demand an inventory line for a module that has no transaction.)
 * Admin-only / default-deny (see
 * `backfillPedidosShopeeMeta` — the schema is not in `ALL_DOMAINS`), so there is
 * no client access and no generated rules block.
 */
export const backfillPedidosShopeeCollection = defineAdminCollection({
  path: backfillPedidosShopeeMeta.collectionPath,
  schema: backfillPedidosShopeeSchema,
});
