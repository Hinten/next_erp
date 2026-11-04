import { produtoLojaIntegradaLinkSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the Loja Integrada listing link doc,
 * `produtos/{produtoId}/produtolojaintegrada/{docId}`, stored in the EXACT old
 * Flutter wire shape the migrated corpus carries (`produtoLojaIntegradaLinkSchema`).
 * Client-side reads go through the loose pass-through subcollection domain
 * (`subcollections.ts`, leaf name `produtolojaintegrada`); this typed handle
 * exists so server reads cannot drift from that wire format.
 *
 * Same file/export shape as `produtoShopeeLinkCollection.ts`, and for the same
 * reason: `groupQuery(db)` is what lets the Loja Integrada order import
 * (master plan step 5) query the collection group without a raw
 * `db.collectionGroup()`, which every app's `no-restricted-syntax` bans.
 *
 * ⚠️ The link docs are read by FIELDS, never by a computed doc id: the migrated
 * docs have mixed ids. The Loja Integrada produto id is the NUMBER field `id`
 * (`z.number().int()`), so a group query must be given a number — its decimal
 * text matches nothing, silently.
 *
 * ⚠️ The conta ref (`contaLojaIntegrada`) is stored in more than one form across
 * the migrated corpus, so the order import filters it with `in` over every
 * accepted form. That makes the group query a COMPOSITE, served by the
 * `produtolojaintegrada (contaLojaIntegrada ASC, id ASC)` collection-group index
 * in `firestore.indexes.json` (`packages/schemas/src/produtoLojaIntegrada.indexes.test.ts`
 * pins it). On Firestore Enterprise an undeclared composite silently full-scans
 * and is billed by data scanned (root `CLAUDE.md` rule 1); DEPLOYING the index
 * is migration-window work, and agents never run it.
 */
export const produtoLojaIntegradaLinkCollection = defineAdminCollection({
  path: 'produtos/{produtoId}/produtolojaintegrada',
  schema: produtoLojaIntegradaLinkSchema,
});
