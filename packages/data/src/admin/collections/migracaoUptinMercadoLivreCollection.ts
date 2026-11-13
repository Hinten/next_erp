import { migracaoUptinMercadoLivreSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

export const migracaoUptinMercadoLivreCollection = defineAdminCollection({
  path: 'migracoesUptinMercadoLivre',
  schema: migracaoUptinMercadoLivreSchema,
});
