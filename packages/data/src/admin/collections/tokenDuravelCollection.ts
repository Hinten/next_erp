import { tokenDuravelMeta, tokenDuravelSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `integracao/{integracaoId}/tokenDuravel` — the Mercado
 * Livre durable OAuth credential in the OLD Flutter wire shape, shared with the
 * still-running Flutter app during the dual-run migration. Server-side only; the
 * browser never touches it (admin-only / default-denied, like `credenciais`).
 */
export const tokenDuravelCollection = defineAdminCollection({
  path: tokenDuravelMeta.collectionPath,
  schema: tokenDuravelSchema,
});
