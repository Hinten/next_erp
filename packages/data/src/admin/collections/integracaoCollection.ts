import { integracaoMeta, integracaoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `integracao` collection — sales-channel account
 * configs (tipo-discriminated: mercadoLivre / shopee / amazon / magalu /
 * lojaIntegrada / facebook / whatsapp / balcao). Per-channel App Hosting
 * backends (e.g. `apps/mercado-livre`) read these server-side to resolve the
 * account before building a `ChannelContext` (the OAuth token lives in the
 * admin-only `integracao/{id}/credenciais` subcollection — see
 * `credenciaisIntegracaoCollection`).
 */
export const integracaoCollection = defineAdminCollection({
  path: integracaoMeta.collectionPath,
  schema: integracaoSchema,
});
