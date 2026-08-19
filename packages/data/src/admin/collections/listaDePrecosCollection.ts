import { listaDePrecosMeta, listaDePrecosSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `listaDePrecos` (price list) collection.
 *
 * Read-only consumer today: `apps/mercado-livre`'s publish flow reads a price
 * list's `nome` to name it, alongside its raw Firestore id, in `resolvePrice`'s
 * blocked-publish message (`listaDePrecosCache.ts`). No server process writes
 * this collection — it is maintained entirely by apps/web's schema-driven CRUD
 * screen at `/listas-de-precos` (browser client).
 */
export const listaDePrecosCollection = defineAdminCollection({
  path: listaDePrecosMeta.collectionPath,
  schema: listaDePrecosSchema,
});
