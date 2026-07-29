import { historicoFreteInicialMeta, historicoFreteInicialSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `pedidos/{pedidoId}/historicoFtIni` — the
 * `freteInicial.estado` audit trail. Written by the Melhor Envio
 * order-status webhook (`apps/melhor-envio/app/api/webhooks/melhor-envio/route.ts`)
 * in the same batch as the `freteInicial` patch, on every genuine estado
 * transition.
 */
export const historicoFreteInicialCollection = defineAdminCollection({
  path: historicoFreteInicialMeta.collectionPath,
  schema: historicoFreteInicialSchema,
});
