import { defineCollection } from '@delfrance/data';
import { impostoCategoriaSchema } from '@delfrance/schemas';

/**
 * The `categorias/{categoriaId}/impostocategoria` subcollection — per-operação
 * fiscal override for a categoria. Doc id is the operação id (deterministic,
 * idempotent). The resolver's cascade falls through to it after `impostoProduto`
 * misses. Scope key is `impostoOperacaoOuterRef` (correct spelling — unlike
 * `impostoProduto`'s Flutter typo `impostoOpercaoOuterRef`).
 */
export const impostoCategoriaCollection = defineCollection({
  path: 'categorias/{categoriaId}/impostocategoria',
  schema: impostoCategoriaSchema,
});
