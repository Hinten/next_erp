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
 * States in which a pedido's items + general data stay EDITABLE — the cart /
 * checkout phase, plus `error` (so a broken pedido can be repaired, matching the
 * legacy `_travar_inclusao_produto` list, whose complement is exactly these).
 * The legacy editor used the inverse "locked" list
 * (`.old/packages/pedido/lib/src/models.dart:2394`) and set
 * `travar_pedido = estado.travar_inclusao_produto`, rendering the cliente /
 * operação / item fields read-only (`pedidoCadastro.dart:396-492`).
 *
 * We model it as an ALLOW-list (like `podeTrocar`) so a newly-added
 * `EstadoPedido` defaults to LOCKED — the safe default.
 */
const ITENS_EDITAVEIS: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  'iniciado',
  'carrinho',
  'carrinhoAbandonado',
  'escolhendoFormaDePagamento',
  'error',
]);

/**
 * Whether the pedido editor must lock item / general-data editing for this
 * estado (legacy `travar_inclusao_produto` → `travar_pedido`). An aprovada NF-e
 * locks the Fiscal tab separately (legacy `travar_fiscal`), regardless of estado.
 */
export function travarInclusaoProduto(estado: EstadoPedido): boolean {
  return !ITENS_EDITAVEIS.has(estado);
}

/* -------------------------------------------------------------------------- */
/*                          Pagamento edit-capability                         */
/* -------------------------------------------------------------------------- */

/**
 * Estados that keep pagamentos editable **even when an aprovada NF-e exists**.
 * The legacy save guard (`cadastroPedidoProvider.dart:749`) blocks pagamentos
 * when `estado != iniciado && has aprovada NF-e`, but the save flow
 * (`:1058-1062`) re-allows the write when the old estado is
 * `aguardandoConfirmacaoDePagamento` or the pedido is being `cancelado`. This
 * ALLOW-list captures those carve-outs so a newly-added `EstadoPedido` defaults
 * to LOCKED-once-NF-e-aprovada — the safe default.
 */
const PAGAMENTO_EDITAVEL_COM_NFE: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  'iniciado',
  'aguardandoConfirmacaoDePagamento',
  'cancelado',
]);

/**
 * Whether pagamentos must be locked for this estado **given that the pedido has
 * an aprovada NF-e** (legacy `travar_fiscal` extends to `canSavePagamentos`).
 * The caller ANDs this with "an NF-e is aprovada" — with no aprovada NF-e,
 * pagamentos stay editable regardless of estado (faithful to the legacy guard).
 */
export function travarPagamentoComNFe(estado: EstadoPedido): boolean {
  return !PAGAMENTO_EDITAVEL_COM_NFE.has(estado);
}

/**
 * Estados in which the pedido is already considered paid / settled, so
 * registering a NEW pagamento is unusual (it would create troco/excedente, or
 * touch an already-refunded order). Drives a soft, non-blocking warning when the
 * user opens the "add pagamento" form — it is NOT a lock.
 */
const PAGAMENTO_INESPERADO: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  'pago',
  'emProcessamento',
  'finalizado',
  'estornadoParcialmente',
  'estornadoIntegralmente',
]);

export function pagamentoInesperado(estado: EstadoPedido): boolean {
  return PAGAMENTO_INESPERADO.has(estado);
}
