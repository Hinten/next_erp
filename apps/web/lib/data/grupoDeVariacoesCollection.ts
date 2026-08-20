import { grupoDeVariacoesSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `grupoDeVariacoes` Firestore collection (variation
 * groups: Tamanho, Cor, …). The path mirrors `grupoDeVariacoesMeta.collectionPath`
 * which is how the migrated corpus stores these docs.
 */
export const grupoDeVariacoesCollection = defineCollection({
  path: 'grupoDeVariacoes',
  schema: grupoDeVariacoesSchema,
});
