import { grupoDeVariacoesSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `grupoDeVariacoes` — variation-group master data
 * (Cor/Tamanho/… + their variantes). Server flows (e.g. the Mercado Livre
 * publish orchestrator) read these to resolve a child produto's
 * `variacoesUid` fake paths into attribute combinations.
 */
export const grupoDeVariacoesCollection = defineAdminCollection({
  path: 'grupoDeVariacoes',
  schema: grupoDeVariacoesSchema,
});
