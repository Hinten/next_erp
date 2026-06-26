import { tabelaDeMedidasMeta, tabelaDeMedidasSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `tabMedi` (tabela de medidas) collection. Used by the
 * arquivo orphan-sweep / media reaper to read a tabela's `fotos` references when
 * deciding which `Arquivo` docs are still owned — the tabMedi analogue of
 * `produtoCollection`. `docRef` is a raw ref (no converter), so the field-masked
 * `getAll` over `fotos` is safe regardless of the schema's `fotos` typing.
 */
export const tabelaDeMedidasCollection = defineAdminCollection({
  path: tabelaDeMedidasMeta.collectionPath,
  schema: tabelaDeMedidasSchema,
});
