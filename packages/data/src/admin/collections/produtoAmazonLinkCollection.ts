import { produtoAmazonLinkSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the Amazon listing link doc,
 * `produtos/{produtoId}/prodAmazon/{docId}`, stored in the EXACT old Flutter wire
 * shape the migrated corpus carries (`produtoAmazonLinkSchema`). Client-side
 * reads go through the loose pass-through subcollection domain
 * (`subcollections.ts`, leaf name `prodAmazon`); this typed handle exists so
 * server reads cannot drift from that wire format.
 *
 * Same file/export shape as the Shopee and Mercado Livre link handles, and for
 * the same reason: its group query is what lets the Amazon order import
 * (Amazon step 5) read the collection group without a raw collection-group
 * call, which every app's `no-restricted-syntax` bans.
 *
 * ⚠️ The link docs are read by FIELDS, never by a computed doc id: the migrated
 * docs have mixed ids. The order import's ONLY lookup is the conta ref (in every
 * accepted stored form) plus the line's seller SKU, as exact bytes; its fields
 * are `CAMPOS_INDICE_VINCULO_AMAZON` (`@delfrance/schemas`), the one spelling of
 * them. That makes it a COMPOSITE, served by the
 * `prodAmazon (contaAmazonOuterRef ASC, sku ASC)` collection-group index in
 * `firestore.indexes.json` (`packages/schemas/src/produtoAmazon.indexes.test.ts`
 * pins it). On Firestore Enterprise an undeclared composite silently full-scans
 * and is billed by data scanned (root `CLAUDE.md` rule 1); DEPLOYING the index is
 * migration-window work, and agents never run it.
 *
 * Step 5 only READS link docs; nothing in this repository writes one yet.
 */
export const produtoAmazonLinkCollection = defineAdminCollection({
  path: 'produtos/{produtoId}/prodAmazon',
  schema: produtoAmazonLinkSchema,
});
