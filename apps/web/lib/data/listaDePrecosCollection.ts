import { listaDePrecosSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

export const listaDePrecosCollection = defineCollection({
  path: 'listaDePrecos',
  schema: listaDePrecosSchema,
});
