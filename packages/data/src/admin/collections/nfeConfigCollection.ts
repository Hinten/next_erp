import { nfeConfigMeta, nfeConfigSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the per-filial `nfeconfig` counter document
 * (`filiais/{filialId}/nfeconfig`). The transactional counter advances
 * (`numeracao_atual`, `idLote`) are validated through this handle.
 */
export const nfeConfigCollection = defineAdminCollection({
  path: nfeConfigMeta.collectionPath,
  schema: nfeConfigSchema,
});
