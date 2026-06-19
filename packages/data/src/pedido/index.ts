/**
 * Pedido domain use-cases behind an SDK-agnostic port (mirrors `../produto`).
 * The web app and a future MCP/admin agent share this orchestration; each
 * supplies its own {@link PedidoDataPort} adapter.
 */
export type { PedidoDataPort, PedidoDocData, PedidoWriteOp } from './port';
export {
  buildPedidoPatch,
  savePedido,
  remotelyChangedFields,
  buildEstadoHistoryOp,
  recordEstadoChange,
  buildIncidenteOp,
  saveIncidente,
  deleteIncidente,
  PedidoConflictError,
  PedidoNothingChangedError,
} from './usecases';
