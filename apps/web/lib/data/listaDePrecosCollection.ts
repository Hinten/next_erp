import { defineCollection } from '@delfrance/data';
import { listaDePrecosSchema } from '@delfrance/schemas';

export const listaDePrecosCollection = defineCollection({
  path: 'listaDePrecos',
  schema: listaDePrecosSchema,
});
