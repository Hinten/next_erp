import { credenciaisIntegracaoMeta, credenciaisIntegracaoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `integracao/{integracaoId}/credenciais` — per-channel
 * marketplace OAuth credentials (Mercado Livre, Amazon, Shopee, Magalu).
 * Single-token semantics: writers must delete older docs in the same
 * transaction so at most one live credential doc exists per channel account
 * (mirrors `tokenMelEnvCollection`). Server-side only; the browser never
 * touches these.
 */
export const credenciaisIntegracaoCollection = defineAdminCollection({
  path: credenciaisIntegracaoMeta.collectionPath,
  schema: credenciaisIntegracaoSchema,
});
