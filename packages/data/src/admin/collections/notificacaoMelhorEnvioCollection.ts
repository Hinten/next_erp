import { notificacaoMelhorEnvioSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/** Admin-only failures store for Melhor Envio webhook notifications (#681). */
export const notificacaoMelhorEnvioCollection = defineAdminCollection({
  path: 'notificacoesMelhorEnvio',
  schema: notificacaoMelhorEnvioSchema,
});
