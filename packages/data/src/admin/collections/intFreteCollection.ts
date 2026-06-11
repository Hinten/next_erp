import { intFreteMeta, intFreteSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `int_frete` collection — freight integration
 * configs (tipo-discriminated: melhorEnvios / motoboy / retiradaNaLoja /
 * fob / marketplaces). Server routes in apps/integrations read these for
 * Melhor Envios credentials and origin addresses.
 */
export const intFreteCollection = defineAdminCollection({
  path: intFreteMeta.collectionPath,
  schema: intFreteSchema,
});
