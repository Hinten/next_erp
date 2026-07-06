import { produtoExtraDataSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `produtos/{produtoId}/extraData` — the fixed
 * `singleton` doc carrying descrição/marca/condição + Google Merchant data.
 * Server flows (e.g. the Mercado Livre publish orchestrator) read it for the
 * listing description and condition.
 */
export const produtoExtraDataCollection = defineAdminCollection({
  path: 'produtos/{produtoId}/extraData',
  schema: produtoExtraDataSchema,
});
