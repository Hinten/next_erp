import { defineCollection } from '@delfrance/data';
import { pedidoSchema } from '@delfrance/schemas';

export const pedidoCollection = defineCollection({
  path: 'pedidos',
  schema: pedidoSchema,
});
