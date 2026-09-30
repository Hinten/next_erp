import { linkPgtoMercadoPagoMeta, linkPgtoMercadoPagoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `pedidos/{pedidoId}/linkPgtoMercadoPago` — the Mercado
 * Pago Checkout Pro payment links an operator generated for a pedido (#367).
 *
 * `serverOwned`: `apps/mercado-pago` is the ONLY writer (the browser reads the
 * collection through the read-only handle in `apps/web/lib/data`). The doc id is
 * the CLIENT-minted link id (`linkPagamentoIdSchema`, the `newDocId()` shape),
 * which travels in the preference's `metadata.link_id` and comes back on the
 * payment as `pagamento.linkPagamentoId` — the MP preference id is the `id`
 * FIELD of the doc, never its key. The backend may also mint an id up front with
 * `newDocId()` from this handle when the caller did not supply one.
 *
 * ⚠️ The corpus imported from the legacy Flutter app carries ODM extras
 * (`docId`/`createTime`/`updateTime`/`readTime`) that the schema strips on read.
 * A status flip on an existing link must therefore be a MERGE patch
 * (`parseMerge`) inside a transaction — never `parse({ ...storedDoc })`, whose
 * strict write re-parse would throw on a key the read parse dropped.
 */
export const linkPgtoMercadoPagoCollection = defineAdminCollection({
  path: linkPgtoMercadoPagoMeta.collectionPath,
  schema: linkPgtoMercadoPagoSchema,
});
