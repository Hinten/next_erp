import { credenciaisLojaIntegradaMeta, credenciaisLojaIntegradaSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `integracao/{integracaoId}/credenciaisLojaIntegrada` — the
 * Loja Integrada Personal Token store, one doc per conta
 * (`CREDENCIAL_LOJA_INTEGRADA_DOC_ID`). Admin-only / default-deny (see
 * `credenciaisLojaIntegradaMeta`); server-side only, the browser never touches
 * these. Mirrors `credenciaisWhatsappCollection`.
 */
export const credenciaisLojaIntegradaCollection = defineAdminCollection({
  path: credenciaisLojaIntegradaMeta.collectionPath,
  schema: credenciaisLojaIntegradaSchema,
});
