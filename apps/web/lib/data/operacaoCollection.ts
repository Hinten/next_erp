import { operacaoSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

export const operacaoCollection = defineCollection({
  path: 'operacao',
  schema: operacaoSchema,
});
