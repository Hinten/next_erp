import { ESTADOS_FRETE_REMOVE_ESTOQUE, type EstadoFrete } from '../../shared/frete';
import { ESTADO_PEDIDO } from '../collection/pedido';
import type { EstadoPedido } from '../collection/pedido';

/* -------------------------------------------------------------------------- */
/*                    Pedido → estoque desired-state predicates               */
/* -------------------------------------------------------------------------- */

/**
 * Estados that HOLD a stock reservation — ported 1:1 from the Dart
 * `ESTADOS_PEDIDO.reservaDeEstoque` list (`.old/.../models.dart:2414`,
 * the `temReserva` getter). A saída pedido whose operação
 * `movimentaIndisponivelEstoque` keeps `quantidadeReservada` bumped while in
 * one of these states; leaving the set releases the reservation.
 */
export const ESTADOS_PEDIDO_RESERVA: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  ESTADO_PEDIDO.escolhendoFormaDePagamento,
  ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  ESTADO_PEDIDO.emAnalise,
  ESTADO_PEDIDO.emProcessamento,
  ESTADO_PEDIDO.pago,
]);

/**
 * Estados in which an APPLIED stock movement stays applied — the Dart
 * `temMovimentacaoDeEstoque` set (`.old/.../models.dart:2418`). Its complement
 * (`iniciado`, `carrinhoAbandonado`, `pagamentoNaoRealizado`,
 * `estornadoIntegralmente`, `cancelado`, `fraude`, `error`) is where a removal /
 * addition is reverted and stock returns to the depósito. Note the asymmetric
 * members: `estornadoParcialmente` and `processandoCancelamento` HOLD an
 * existing movement but never START one (see `efeitoEstoquePedido`).
 */
export const ESTADOS_PEDIDO_MOVIMENTACAO: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  ESTADO_PEDIDO.carrinho,
  ESTADO_PEDIDO.escolhendoFormaDePagamento,
  ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  ESTADO_PEDIDO.emAnalise,
  ESTADO_PEDIDO.emProcessamento,
  ESTADO_PEDIDO.pago,
  ESTADO_PEDIDO.estornadoParcialmente,
  ESTADO_PEDIDO.processandoCancelamento,
  ESTADO_PEDIDO.finalizado,
]);

/** Inputs of {@link efeitoEstoquePedido} — everything read off the pedido + operação. */
export interface EfeitoEstoqueInput {
  estado: EstadoPedido;
  /** `pedido.freteInicial?.estado` — null when the pedido has no freight block. */
  estadoFrete: EstadoFrete | null;
  /** Direction of the resolved operação (`operacao.tipo === saída`). */
  ehSaida: boolean;
  /** `operacao.movimentaEstoque` — physical quantity moves. */
  movimentaEstoque: boolean;
  /** `operacao.movimentaIndisponivelEstoque` — reservation tracking. */
  movimentaIndisponivelEstoque: boolean;
  /**
   * Whether a physical movement is currently applied for this pedido (saída
   * removal or entrada addition — the `estoqueAplicado` snapshot has a non-empty
   * `removido`/`adicionado` map). Movements have HYSTERESIS: they START only on
   * the entry conditions below, but once applied they persist through every
   * `ESTADOS_PEDIDO_MOVIMENTACAO` state (e.g. a partial refund of a delivered
   * order must NOT restock) and revert only outside that set.
   */
  jaMovimentado: boolean;
}

/**
 * The pedido's desired stock effect. At most one of `remover`/`adicionar` is
 * true (direction decides); `reservar` is exclusive with `remover` (a removal
 * consumes the reservation).
 */
export interface EfeitoEstoquePedido {
  /** Hold `quantidadeReservada` for the pedido's items (saída only). */
  reservar: boolean;
  /** Physical stock out of the depósito (saída). */
  remover: boolean;
  /** Physical stock into the depósito (entrada). */
  adicionar: boolean;
}

export const EFEITO_ESTOQUE_NENHUM: EfeitoEstoquePedido = {
  reservar: false,
  remover: false,
  adicionar: false,
};

/**
 * Compute the stock effect a pedido SHOULD currently have — the convergence
 * target the estoque sync diffs against its applied snapshot. Pure port of the
 * legacy decision spread across `managerEstoquePedido2` /
 * `_continuarAlteracaoEstoque` / `_quantidadeRemovida` / `_quantidadeReservada`
 * (`.old/packages/pedido/lib/src/tasks.dart`), with two deliberate fixes:
 *
 *  - A saída with freight assigned during checkout no longer hard-removes at
 *    `escolhendoFormaDePagamento` (legacy early-removal quirk, tasks.dart:769):
 *    removal starts only at `finalizado` or a shipped-side frete estado.
 *  - A pedido jumping straight to `finalizado` from a non-reserva state now
 *    moves stock (legacy `_continuarAlteracaoEstoque` returned false — the
 *    movement never happened).
 *  - A reservation of a reserve-only operação (`movimentaEstoque` false) is
 *    RELEASED at `finalizado`. Legacy held it through every
 *    `temMovimentacaoDeEstoque` state forever (`_quantidadeReservada` keyed on
 *    that set), leaking reserved stock on completed orders — the drift the
 *    `recalcularIndisponivel.dart` repair script existed to clean up.
 *
 * Entry vs hold (hysteresis, matching legacy behavior):
 *  - reservation: enter AND hold on `ESTADOS_PEDIDO_RESERVA` (no hysteresis —
 *    legacy released whenever `temReserva` was false while reserved);
 *  - physical movement: enter on `finalizado` / frete ∈
 *    `ESTADOS_FRETE_REMOVE_ESTOQUE` / (reservation-less saída or entrada) a
 *    reserva-phase estado; hold on `ESTADOS_PEDIDO_MOVIMENTACAO`.
 *
 * `ESTADOS_FRETE_IGNORAR_REMOCAO` needs no explicit check here: it is disjoint
 * from `ESTADOS_FRETE_REMOVE_ESTOQUE` (asserted in the unit tests), so an
 * unknown/errored frete estado never starts a removal, and an applied movement
 * is held by the pedido estado, not the frete.
 */
export function efeitoEstoquePedido(input: EfeitoEstoqueInput): EfeitoEstoquePedido {
  const { estado, estadoFrete, ehSaida, movimentaEstoque, movimentaIndisponivelEstoque } = input;

  if (!movimentaEstoque && !movimentaIndisponivelEstoque) return EFEITO_ESTOQUE_NENHUM;

  const estadoAtivo = ESTADOS_PEDIDO_MOVIMENTACAO.has(estado);
  const emReserva = ESTADOS_PEDIDO_RESERVA.has(estado);
  const freteRemove = estadoFrete !== null && ESTADOS_FRETE_REMOVE_ESTOQUE.has(estadoFrete);

  if (!ehSaida) {
    // Entrada (compra / devolução): physical addition only, never a reservation.
    const entrada = emReserva || estado === ESTADO_PEDIDO.finalizado;
    const adicionar = movimentaEstoque && (input.jaMovimentado ? estadoAtivo : entrada);
    return { reservar: false, remover: false, adicionar };
  }

  // Saída: a reservation-less operação treats "sold" as "gone" already during
  // the reserva phase (legacy parity — with no reservada tracking, waiting for
  // shipment would just hide the sale from available stock).
  const entradaRemocao =
    estado === ESTADO_PEDIDO.finalizado ||
    freteRemove ||
    (!movimentaIndisponivelEstoque && emReserva);
  const remover = movimentaEstoque && (input.jaMovimentado ? estadoAtivo : entradaRemocao);
  const reservar = movimentaIndisponivelEstoque && emReserva && !remover;
  return { reservar, remover, adicionar: false };
}
