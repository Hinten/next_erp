import { estoqueMercadoLivreSyncMeta, estoqueMercadoLivreSyncSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `estoqueMercadoLivreSync` per-conta state doc
 * (Step 10 stock sync) — the ML stock sweeps (apps/mercado-livre nested
 * functions) read the incremental cursor + 429 pause gate before discovering
 * changed estoques, and the send-task handler merges pause state after a
 * rate-limit; doc id = integracaoId. Admin-only / default-deny (see
 * `estoqueMercadoLivreSyncMeta` — the schema is not in `ALL_DOMAINS`), so
 * there is no client access and no generated rules block.
 */
export const estoqueMercadoLivreSyncCollection = defineAdminCollection({
  path: estoqueMercadoLivreSyncMeta.collectionPath,
  schema: estoqueMercadoLivreSyncSchema,
});
