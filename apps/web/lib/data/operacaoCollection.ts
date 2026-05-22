import { defineCollection } from '@delfrance/data';
import { operacaoSchema } from '@delfrance/schemas';

export const operacaoCollection = defineCollection({
  path: 'operacao',
  schema: operacaoSchema,
});
