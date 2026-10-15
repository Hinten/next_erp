import { defineCollection } from '@delfrance/data';
import { linkPgtoMercadoPagoSchema } from '@delfrance/schemas';

/**
 * Subcollection: `pedidos/{pedidoId}/linkPgtoMercadoPago` — Mercado Pago Checkout Pro
 * payment links created by an operator to settle a saída pedido. READ-ONLY in the browser
 * (serverOwned; apps/mercado-pago writes it).
 */
export const linkPgtoMercadoPagoCollection = defineCollection({
  path: 'pedidos/{pedidoId}/linkPgtoMercadoPago',
  schema: linkPgtoMercadoPagoSchema,
});
