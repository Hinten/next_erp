import { tokenDuravelMeta, tokenDuravelSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `integracao/{integracaoId}/tokenDuravel` — the Mercado
 * Livre durable OAuth credential in the OLD Flutter wire shape, which is how the
 * migrated corpus is stored. Server-side only; the
 * browser never touches it (admin-only / default-denied, like `credenciais`).
 */
export const tokenDuravelCollection = defineAdminCollection({
  path: tokenDuravelMeta.collectionPath,
  schema: tokenDuravelSchema,
});
