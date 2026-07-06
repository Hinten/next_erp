import { defineCollection } from '@delfrance/data';
import { impostoCategoriaSchema } from '@delfrance/schemas';

/**
 * The `categorias/{categoriaId}/imposto` subcollection (legacy Flutter wire
 * name, #423) — per-operação fiscal override for a categoria. Doc id is the
 * operação id (deterministic, idempotent). The resolver's cascade falls
 * through to it after `impostoProduto` misses. Scope key is the legacy
 * `impostoCategoriaOperacaoOuterRef` (the produto tier keeps Flutter's typo
 * key `impostoOpercaoOuterRef` — three different keys, one role).
 */
export const impostoCategoriaCollection = defineCollection({
  path: 'categorias/{categoriaId}/imposto',
  schema: impostoCategoriaSchema,
});
