import { freteDoPedidoSchema, type FreteDoPedido, type ModalidadeFrete } from '@delfrance/schemas';

/**
 * Seed a fresh `freteInicial` block when the user first picks a freight
 * modalidade on a pedido without one. Every wire key starts at its schema
 * (Flutter) default, except the direction-aware `ehReverso`: an entrada
 * (`ehSaida: false`) is a cliente → loja shipment, so its freight defaults
 * to reverse (legacy parity).
 */
export function seedFreteInicial(modalidade: ModalidadeFrete, ehSaida: boolean): FreteDoPedido {
  return freteDoPedidoSchema.parse({ estado: 'iniciado', modalidade, ehReverso: !ehSaida });
}
