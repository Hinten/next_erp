/**
 * Pure Melhor Envio label-state rules shared by purchases and notifications.
 */
import { ESTADO_FRETE, type EstadoFrete } from '@delfrance/schemas';

/** ME order status → the legacy `EstadoFrete` mapping. */
export function meStatusToEstadoFrete(status: string | null | undefined): EstadoFrete | null {
  switch (status) {
    case 'delivered':
      return ESTADO_FRETE.entregue;
    case 'released':
      return null;
    case 'posted':
    case 'received':
      return ESTADO_FRETE.postado;
    case 'canceled':
    case 'cancelled':
      return ESTADO_FRETE.cancelado;
    case 'suspended':
    case 'paused':
      return ESTADO_FRETE.suspenso;
    case 'undelivered':
      return ESTADO_FRETE.falhaNaEntrega;
    case null:
    case undefined:
    default:
      return null;
  }
}

/** Raw Firestore states are tolerant; only these two exact states are terminal. */
export function ehEstadoFreteTerminal(
  estado: unknown,
): estado is typeof ESTADO_FRETE.entregue | typeof ESTADO_FRETE.cancelado {
  return estado === ESTADO_FRETE.entregue || estado === ESTADO_FRETE.cancelado;
}

/**
 * Reset provider states belonging to an earlier shipment when installing a
 * NEW anchor. Null means the stored state does not need a reset.
 *
 * A canceled shipment has not necessarily moved stock: `iniciado` keeps that
 * effect until purchase finalization succeeds. The other provider states and their reset
 * already have the same physical-stock effect.
 */
export function estadoAoAncorarNovaEtiqueta(estadoAtual: unknown): EstadoFrete | null {
  switch (estadoAtual) {
    case ESTADO_FRETE.cancelado:
      return ESTADO_FRETE.iniciado;
    case ESTADO_FRETE.postado:
    case ESTADO_FRETE.entregue:
    case ESTADO_FRETE.suspenso:
    case ESTADO_FRETE.falhaNaEntrega:
      return ESTADO_FRETE.aguardandoPostagem;
    default:
      return null;
  }
}

/**
 * Select the purchase's final state from its transaction-fresh pedido.
 *
 * A fresh anchor resets states belonging to the previous shipment (#1801).
 * Any posted or terminal state seen here therefore belongs to the anchored
 * label, including a webhook that arrived after the final provider fetch.
 */
export function resolverEstadoFinalCompraEtiqueta(
  estadoAtual: unknown,
  statusMe: string | null | undefined,
): EstadoFrete {
  if (ehEstadoFreteTerminal(estadoAtual)) return estadoAtual;
  const candidato = meStatusToEstadoFrete(statusMe) ?? ESTADO_FRETE.aguardandoPostagem;
  if (estadoAtual === ESTADO_FRETE.postado && candidato === ESTADO_FRETE.aguardandoPostagem) {
    return ESTADO_FRETE.postado;
  }
  return candidato;
}
