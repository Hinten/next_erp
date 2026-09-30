import { ESTADO_NFE, type EstadoNFe } from '../../nfe';
import { ESTADO_PEDIDO } from '../collection/pedido';
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
  ESTADO_PEDIDO.pago,
  ESTADO_PEDIDO.estornadoParcialmente,
  ESTADO_PEDIDO.finalizado,
]);

export function podeTrocar(estado: EstadoPedido): boolean {
  return PODE_TROCAR.has(estado);
}

/**
 * Estados from which issuing an NF-e is forbidden: a pedido that was cancelled,
 * had its payment refused, was integrally reversed, or was flagged as fraud is
 * not a live sale — emitting a fiscal document for it creates an undue tax
 * liability that can only be undone via SEFAZ cancelamento within 24h. Mirrors
 * the legacy skip in `.old/packages/pedido_nfe/lib/src/tasks.dart`
 * (`skipPorDiversosMotivos`).
 *
 * Deliberately EXCLUDED so they stay emittable: `error` (a broken pedido is
 * repairable, then emittable) and `estornadoParcialmente` (a real, partly
 * refunded sale that still needs its NF-e). Cart / pre-sale states ('carrinho',
 * 'iniciado', …) are left to the caller/UI — this guard only blocks the states
 * that unambiguously represent a voided sale.
 */
const EMISSAO_NFE_BLOQUEADA: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  ESTADO_PEDIDO.carrinhoAbandonado,
  ESTADO_PEDIDO.pagamentoNaoRealizado,
  ESTADO_PEDIDO.estornadoIntegralmente,
  ESTADO_PEDIDO.processandoCancelamento,
  ESTADO_PEDIDO.cancelado,
  ESTADO_PEDIDO.fraude,
]);

/**
 * Whether a pedido in this estado must NOT be emitted as an NF-e. Used
 * server-side in `prepareEmission` and reusable client-side to pre-filter a
 * bulk-emit selection. See {@link EMISSAO_NFE_BLOQUEADA} for the rationale.
 */
export function emissaoNFeBloqueadaPorEstado(estado: EstadoPedido): boolean {
  return EMISSAO_NFE_BLOQUEADA.has(estado);
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
  ESTADO_PEDIDO.iniciado,
  ESTADO_PEDIDO.carrinho,
  ESTADO_PEDIDO.carrinhoAbandonado,
  ESTADO_PEDIDO.escolhendoFormaDePagamento,
  ESTADO_PEDIDO.error,
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
  ESTADO_PEDIDO.iniciado,
  ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  ESTADO_PEDIDO.cancelado,
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
  ESTADO_PEDIDO.pago,
  ESTADO_PEDIDO.emProcessamento,
  ESTADO_PEDIDO.finalizado,
  ESTADO_PEDIDO.estornadoParcialmente,
  ESTADO_PEDIDO.estornadoIntegralmente,
]);

export function pagamentoInesperado(estado: EstadoPedido): boolean {
  return PAGAMENTO_INESPERADO.has(estado);
}

/**
 * NF-e states that have closed this pedido's fiscal lifecycle at SEFAZ —
 * `cancelada` and `numeracaoInutilizada`. Like an `aprovada` NF-e they lock the
 * pedido's Fiscal tab and pagamentos, but **hard**: unlike `aprovada` (which the
 * legacy save flow re-allows in a few pedido estados via `travarPagamentoComNFe`),
 * a cancelada/inutilizada NF-e blocks fiscal + payment edits outright — there is
 * nothing left to change. Lives here (not in `nfe.ts`) with the other pedido-lock
 * predicates so a UI-only edit does not re-trigger the live SEFAZ CI pipeline.
 */
export function nfeFiscalEncerrada(estado: EstadoNFe): boolean {
  return estado === ESTADO_NFE.cancelada || estado === ESTADO_NFE.numeracaoInutilizada;
}

/* -------------------------------------------------------------------------- */
/*                     Payment links (Mercado Pago, #367)                      */
/* -------------------------------------------------------------------------- */

/**
 * Estados in which a Mercado Pago payment link may be GENERATED.
 *
 * ⚠️ This is a NEW gate, not a port. The legacy app never checked the estado
 * before creating a link (`.old/packages/pagamento/mercado_pago/lib/src/utils.dart:6-121`
 * goes straight to the preference POST; its only estado logic is the
 * `iniciado` flip at `:97-112`). The members below are the legacy
 * `ESTADOS_PEDIDO.estadosConferirPagamento` set
 * (`.old/packages/pedido/lib/src/models.dart:2489-2495`), which the legacy app
 * used to gate the payment RECONCILE — reused here because it is exactly the
 * set in which an approved payment can still move the pedido to `pago`, so a
 * link created in one of these estados can actually settle it. Every member
 * also has `nextPedidoEstado(e, total, total, total) === pago` (pinned by a
 * cross-module test in `packages/data`), so the allow-list can never drift out
 * of the payment-driven estados.
 *
 * ALLOW-list, like {@link podeTrocar}: a newly-added `EstadoPedido` defaults to
 * "no link" — the safe default. `pago`, `emProcessamento` and the cancelled /
 * refunded estados are out: a link there can only overpay (an overpayment
 * blocks NF-e emission with cStat 866 — Mercado Pago money is never tPag 01
 * dinheiro, so no troco is allowed) or charge a dead sale.
 *
 * This says nothing about the sales CHANNEL: a marketplace pedido sits in
 * `carrinho` / `escolhendoFormaDePagamento` too, and its estado belongs to the
 * marketplace ladder. That is a separate reason (`canal`) in
 * `motivoBloqueioLinkPagamento`.
 */
const PODE_GERAR_LINK_PAGAMENTO: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  ESTADO_PEDIDO.iniciado,
  ESTADO_PEDIDO.carrinho,
  ESTADO_PEDIDO.escolhendoFormaDePagamento,
  ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  ESTADO_PEDIDO.pagamentoNaoRealizado,
]);

/** Whether a payment link may be generated from this estado. See {@link PODE_GERAR_LINK_PAGAMENTO}. */
export function podeGerarLinkPagamento(estado: EstadoPedido): boolean {
  return PODE_GERAR_LINK_PAGAMENTO.has(estado);
}

/**
 * The estado a pedido moves to when its FIRST link is generated, or `null` when
 * the creation leaves the estado alone.
 *
 * Owner decision (#367): flip on creation, as the legacy app did
 * (`.old/packages/pagamento/mercado_pago/lib/src/utils.dart:97-112`) — and only
 * from `iniciado`. Every other estado in {@link podeGerarLinkPagamento} is
 * already at or past "waiting for payment" (or is a retry after a refusal), so
 * moving it would rewrite a state the operator or a payment set on purpose.
 * `carrinho` in particular returns `null`: it is not `iniciado`.
 *
 * The write is server-side only: `historicoEstadoPedido` is server-owned, so
 * the flip has to go through the same path that records who did it.
 */
export function estadoAoGerarLinkPagamento(estado: EstadoPedido): EstadoPedido | null {
  return estado === ESTADO_PEDIDO.iniciado ? ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento : null;
}
