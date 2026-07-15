import { credenciaisMetodoPgtoMeta, credenciaisMetodoPgtoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `metodo_pgto/{metodoId}/credenciais` — Mercado Pago
 * OAuth credentials. Single-token semantics: writers must delete older docs
 * in the same transaction so at most one live credential doc exists per
 * account (mirrors `credenciaisIntegracaoCollection`). Server-side only; the
 * browser never touches these.
 */
export const credenciaisMetodoPgtoCollection = defineAdminCollection({
  path: credenciaisMetodoPgtoMeta.collectionPath,
  schema: credenciaisMetodoPgtoSchema,
});
