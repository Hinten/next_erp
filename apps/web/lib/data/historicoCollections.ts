import { defineCollection } from '@delfrance/data';
import { historicoCustoSchema, historicoPrecoSchema } from '@delfrance/schemas';

/**
 * Price-change history of a produto — written by the Flutter `Produto.save()`
 * and by the Next produto editor on every `precos` change (see `diffPrecos`).
 * Path mirrors the Flutter `HISTORICO_PRECO_COLLECTION`.
 */
export const historicoPrecoCollection = defineCollection({
  path: 'produtos/{produtoId}/historicoDePrecos',
  schema: historicoPrecoSchema,
});

/**
 * Cost history ("data da compra") — the Next editor records every `custo`
 * change here (`appendCustoHistory`); the old Flutter app defines the model +
 * rules but never wrote records. Same wire shape, so reads coexist.
 */
export const historicoCustoCollection = defineCollection({
  path: 'produtos/{produtoId}/historicoDeCusto',
  schema: historicoCustoSchema,
});
