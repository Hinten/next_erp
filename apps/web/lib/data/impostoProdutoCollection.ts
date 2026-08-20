import { defineCollection } from '@delfrance/data';
import { impostoProdutoSchema } from '@delfrance/schemas';

/**
 * The `produtos/{produtoId}/imposto` subcollection — per-operação fiscal
 * override for a produto. Doc id is the operação id (deterministic, idempotent),
 * matching the Flutter `Imposto.copyWithParent(docIdString: operacaoId)` so both
 * migrated docs resolve natively.
 */
export const impostoProdutoCollection = defineCollection({
  path: 'produtos/{produtoId}/imposto',
  schema: impostoProdutoSchema,
});
