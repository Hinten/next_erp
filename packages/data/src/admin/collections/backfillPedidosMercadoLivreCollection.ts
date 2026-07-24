import {
  backfillPedidosMercadoLivreMeta,
  backfillPedidosMercadoLivreSchema,
} from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `backfillPedidosMercadoLivre` per-conta
 * cursor doc (#360, Step 9 PR 4) — the 15-minute order-backfill sweep
 * (apps/mercado-livre nested functions) reads the high-water mark before
 * paging `GET /orders/search` and merges it forward only after a conta's
 * pages+enqueues succeeded; doc id = integracaoId. Admin-only / default-deny
 * (see `backfillPedidosMercadoLivreMeta` — the schema is not in
 * `ALL_DOMAINS`), so there is no client access and no generated rules block.
 */
export const backfillPedidosMercadoLivreCollection = defineAdminCollection({
  path: backfillPedidosMercadoLivreMeta.collectionPath,
  schema: backfillPedidosMercadoLivreSchema,
});
