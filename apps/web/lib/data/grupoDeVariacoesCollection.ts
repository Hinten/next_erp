import { grupoDeVariacoesSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `grupoDeVariacoes` Firestore collection (variation
 * groups: Tamanho, Cor, …). The path mirrors `grupoDeVariacoesMeta.collectionPath`
 * so the rewrite coexists with the Flutter app on the same docs.
 */
export const grupoDeVariacoesCollection = defineCollection({
  path: 'grupoDeVariacoes',
  schema: grupoDeVariacoesSchema,
});
