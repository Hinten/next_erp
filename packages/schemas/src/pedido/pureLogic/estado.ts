import type { EstadoPedido } from '../collection/pedido';

/* -------------------------------------------------------------------------- */
/*                          Kanban / status helpers                           */
/* -------------------------------------------------------------------------- */

/**
 * Visual buckets for the kanban view. The 16 raw states are too many to
 * render as columns; we group into 4 lanes that match how the team
 * thinks about pedido lifecycle.
 */
export type EstadoBucket = 'aberto' | 'processo' | 'concluido' | 'cancelado';

export const ESTADO_BUCKET_LABELS: Record<EstadoBucket, string> = {
  aberto: 'Em aberto',
  processo: 'Em processo',
  concluido: 'Concluído',
  cancelado: 'Cancelado / Erro',
};

const BUCKET_BY_STATE: Record<EstadoPedido, EstadoBucket> = {
  iniciado: 'aberto',
  carrinho: 'aberto',
  escolhendoFormaDePagamento: 'aberto',
  aguardandoConfirmacaoDePagamento: 'aberto',
  emAnalise: 'processo',
  emProcessamento: 'processo',
  pago: 'concluido',
  finalizado: 'concluido',
  carrinhoAbandonado: 'cancelado',
  pagamentoNaoRealizado: 'cancelado',
  estornadoParcialmente: 'cancelado',
  estornadoIntegralmente: 'cancelado',
  processandoCancelamento: 'cancelado',
  cancelado: 'cancelado',
  fraude: 'cancelado',
  error: 'cancelado',
};

export function bucketOf(estado: EstadoPedido): EstadoBucket {
  return BUCKET_BY_STATE[estado];
}

/**
 * States from which a pedido's items can be RETURNED (devolução): only
 * paid/settled orders. The legacy `ESTADOS_PEDIDO.podeTrocar`
 * (`.old/.../models.dart:2430`) used an exclusion list; we use the equivalent
 * ALLOW-list (its complement) so a newly-added `EstadoPedido` defaults to
 * "not returnable" — the safe default.
 */
const PODE_TROCAR: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  'pago',
  'estornadoParcialmente',
  'finalizado',
]);

export function podeTrocar(estado: EstadoPedido): boolean {
  return PODE_TROCAR.has(estado);
}

/* -------------------------------------------------------------------------- */
/*                        Edit-capability locking                             */
/* -------------------------------------------------------------------------- */

/**
 * States in which a pedido's items + general data are LOCKED for editing —
 * ported verbatim from the legacy `ESTADOS_PEDIDO._travar_inclusao_produto`
 * (`.old/packages/pedido/lib/src/models.dart:2394`). The legacy editor sets
 * `travar_pedido = estado.travar_inclusao_produto` and renders the cliente /
 * operação / item fields read-only (`pedidoCadastro.dart:396-492`).
 *
 * The complement — `iniciado`, `carrinho`, `carrinhoAbandonado`,
 * `escolhendoFormaDePagamento` (and `error`) — stays editable: items can only be
 * changed while the order is still in the cart/checkout phase. `error` is left
 * editable, matching the legacy list, so a broken pedido can be repaired.
 */
const TRAVAR_INCLUSAO_PRODUTO: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  'aguardandoConfirmacaoDePagamento',
  'pagamentoNaoRealizado',
  'emAnalise',
  'emProcessamento',
  'pago',
  'estornadoParcialmente',
  'estornadoIntegralmente',
  'processandoCancelamento',
  'cancelado',
  'fraude',
  'finalizado',
]);

/**
 * Whether the pedido editor must lock item / general-data editing for this
 * estado (legacy `travar_inclusao_produto` → `travar_pedido`). An aprovada NF-e
 * locks the Fiscal tab separately (legacy `travar_fiscal`), regardless of estado.
 */
export function travarInclusaoProduto(estado: EstadoPedido): boolean {
  return TRAVAR_INCLUSAO_PRODUTO.has(estado);
}
