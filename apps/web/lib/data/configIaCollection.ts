import { defineCollection } from '@delfrance/data';
import { configIaSchema } from '@delfrance/schemas';

/**
 * Collection: `configIa` — one document per AI agent, each a singleton keyed by
 * purpose (the `counters` shape, not a listable collection). Read and written
 * by known id; there is no list screen and no `defaultQuery`.
 */
export const configIaCollection = defineCollection({
  path: 'configIa',
  schema: configIaSchema,
});

export { CONFIG_IA_ML_ATRIBUTOS_DOC_ID } from '@delfrance/schemas';
