import { defineCollection } from '@delfrance/data';
import { conversaSchema, mensagemSchema } from '@delfrance/schemas';

export const conversaCollection = defineCollection({
  path: 'chat',
  schema: conversaSchema,
});

/**
 * Subcollection: `chat/{conversaId}/mensagem`. Pass `{ conversaId }` to
 * the path context.
 */
export const mensagemCollection = defineCollection({
  path: 'chat/{conversaId}/mensagem',
  schema: mensagemSchema,
});
