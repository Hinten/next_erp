import { tokenMelEnvMeta, tokenMelEnvSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `int_frete/{intFreteId}/tokenMelEnv` — Melhor
 * Envios OAuth tokens. Single-token semantics: writers must delete older
 * docs in the same transaction (the legacy Flutter app enforced at most
 * one live token per conta). Server-side only; the browser never touches
 * these.
 */
export const tokenMelEnvCollection = defineAdminCollection({
  path: tokenMelEnvMeta.collectionPath,
  schema: tokenMelEnvSchema,
});
