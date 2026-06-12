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
 * Cost history ("data da compra") — READ-ONLY in the Next app: the old app
 * defines the model + rules but never writes records; we only display what
 * exists (decision 2026-06-12).
 */
export const historicoCustoCollection = defineCollection({
  path: 'produtos/{produtoId}/historicoDeCusto',
  schema: historicoCustoSchema,
});
