import { defineCollection } from '@delfrance/data';
import { counterSchema } from '@delfrance/schemas';

export const counterCollection = defineCollection({
  path: 'counters',
  schema: counterSchema,
});
