import { defineCollection } from '@delfrance/data';
import { intFreteSchema } from '@delfrance/schemas';

export const intFreteCollection = defineCollection({
  path: 'int_frete',
  schema: intFreteSchema,
});
