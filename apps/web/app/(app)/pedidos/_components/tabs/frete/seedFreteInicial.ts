import { freteDoPedidoSchema, type FreteDoPedido, type ModalidadeFrete } from '@delfrance/schemas';

/**
 * Seed a fresh `freteInicial` block when the user first picks a freight
 * modalidade on a pedido without one. Every wire key starts at its schema
 * default, which is Flutter's — with two exceptions. `ehReverso` is
 * direction-aware: an entrada (`ehSaida: false`) is a cliente → loja shipment,
 * so its freight defaults to reverse (legacy parity). And `modalidade` always
 * comes from the caller here, so its schema default never applies — that
 * default deliberately diverges from Flutter's read default (#1090).
 */
export function seedFreteInicial(modalidade: ModalidadeFrete, ehSaida: boolean): FreteDoPedido {
  return freteDoPedidoSchema.parse({ estado: 'iniciado', modalidade, ehReverso: !ehSaida });
}
