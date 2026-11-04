import { categoriaLojaIntegradaLinkSchema, categoriaMeta } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the Loja Integrada CATEGORY link doc,
 * `categorias/{categoriaId}/categorialojaintegrada/{docId}` (`categoriaLojaIntegradaLinkSchema`):
 * one ERP categoria tied to one store category. Admin-only: no client domain reads it, and no
 * rules block matches it.
 *
 * `groupQuery(db)` is what lets the product import (master plan step 9) read the collection group
 * without a raw `db.collectionGroup()`, which every app's `no-restricted-syntax` bans.
 *
 * ⚠️ Read WHOLE, never filtered: the migrated docs carry no conta field and keep the store
 * category id as TEXT, so a typed `(contaLojaIntegrada, id)` query would never match one
 * (Firestore equality is type-strict). The import reads the (small) group once per job and decides
 * each doc through `idCategoriaLiDoVinculo` and `vinculoCategoriaServeAConta`. That is also why no
 * index is declared for it: an unfiltered collection-group read needs none.
 */
export const categoriaLojaIntegradaLinkCollection = defineAdminCollection({
  path: `${categoriaMeta.collectionPath}/{categoriaId}/categorialojaintegrada`,
  schema: categoriaLojaIntegradaLinkSchema,
});
