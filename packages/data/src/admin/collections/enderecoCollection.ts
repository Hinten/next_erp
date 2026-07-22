import { enderecoMeta, enderecoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `clientes/{clienteId}/enderecos` — a cliente's saved
 * addresses. The Step 9 Mercado Livre order-import flow (`apps/mercado-livre`)
 * uses it to find-or-create the buyer's endereço (deterministic sha1 doc id,
 * `makeEnderecoId`) built from the ML billing info / shipment receiver address.
 */
export const enderecoCollection = defineAdminCollection({
  path: enderecoMeta.collectionPath,
  schema: enderecoSchema,
});
