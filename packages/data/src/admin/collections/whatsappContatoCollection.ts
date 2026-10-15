import {
  whatsappIdentidadeSchema,
  whatsappConversaSchema,
  whatsappMensagemSchema,
  whatsappConversaAliasSchema,
  whatsappMensagemAliasSchema,
  whatsappVinculoSchema,
  whatsappVinculoMensagemSchema,
} from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

export const whatsappIdentidadeCollection = defineAdminCollection({
  path: 'whatsappIdentidades',
  schema: whatsappIdentidadeSchema,
});
export const whatsappConversaCollection = defineAdminCollection({
  path: 'whatsappConversas',
  schema: whatsappConversaSchema,
});
export const whatsappMensagemCollection = defineAdminCollection({
  path: 'whatsappMensagens',
  schema: whatsappMensagemSchema,
});
export const whatsappConversaAliasCollection = defineAdminCollection({
  path: 'whatsappConversaAliases',
  schema: whatsappConversaAliasSchema,
});
export const whatsappMensagemAliasCollection = defineAdminCollection({
  path: 'whatsappConversaAliases/{conversaId}/mensagens',
  schema: whatsappMensagemAliasSchema,
});
export const whatsappVinculoCollection = defineAdminCollection({
  path: 'whatsappVinculos',
  schema: whatsappVinculoSchema,
});
export const whatsappVinculoMensagemCollection = defineAdminCollection({
  path: 'whatsappVinculos/{vinculoId}/mensagens',
  schema: whatsappVinculoMensagemSchema,
});
