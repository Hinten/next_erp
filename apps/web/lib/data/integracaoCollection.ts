import { defineCollection } from '@delfrance/data';
import { integracaoSchema } from '@delfrance/schemas';

export const integracaoCollection = defineCollection({
  path: 'integracao',
  schema: integracaoSchema,
});
