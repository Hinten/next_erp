import { historicoFreteInicialMeta, historicoFreteInicialSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `pedidos/{pedidoId}/historicoFtIni` — the
 * `freteInicial.estado` audit trail. Rows are written SOLELY by the
 * `onPedidoEstadoChanged` Cloud Function
 * (`apps/functions/src/pedidos/registrarEstadoPedido.ts`), which observes every
 * pedido write and appends one row per genuine `freteInicial.estado`
 * transition. Nothing else writes here: a caller that flips the frete estado
 * (the payment reconciles in `../pedidoReconcile.ts`, the Frete tab, the
 * despacho checkout) only writes the pedido, and the trigger turns that write
 * into the trail row — appending one by hand would duplicate every entry.
 */
export const historicoFreteInicialCollection = defineAdminCollection({
  path: historicoFreteInicialMeta.collectionPath,
  schema: historicoFreteInicialSchema,
});
