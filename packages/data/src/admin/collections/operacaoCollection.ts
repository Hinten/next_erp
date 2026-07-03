import { operacaoMeta, operacaoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `operacao` collection — fiscal operation configs.
 * The pedido→estoque sync (`sincronizarEstoquePedido`, apps/functions) reads the
 * pedido's operação server-side for its stock flags (`movimentaEstoque`,
 * `movimentaIndisponivelEstoque`) and direction (`tipo`).
 */
export const operacaoCollection = defineAdminCollection({
  path: operacaoMeta.collectionPath,
  schema: operacaoSchema,
});
