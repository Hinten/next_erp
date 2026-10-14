import { z } from 'zod';
import { MOTIVO_PEDIDO_CONTESTADO_LI, type MotivoPedidoContestadoLi } from './aviso';
import { STATUS_PAGAMENTO, type StatusPagamento } from './pedido/collection/pagamento';
import { ESTADO_PEDIDO, type EstadoPedido } from './pedido/collection/pedido';

/* -------------------------------------------------------------------------- */
/*        Loja Integrada: the situação codigo → estado / payment table         */
/* -------------------------------------------------------------------------- */

/**
 * THE table that turns a Loja Integrada order's situação into an ERP estado and
 * a payment status (master plan step 5, #1817; step 6, #1818). ONE copy for
 * every surface (#1369): the order importer of `apps/loja-integrada`, the label
 * step's paid re-check (step 15) and anything in `apps/web` that has to say
 * what an LI situação means all read it.
 *
 * ## Keyed by the CODIGO, never by the flags
 *
 * Estado and payment status come from the situação codigo through this table,
 * never from the situação flags. The flags cannot decide: in the platform's own
 * catalogue `pedido_entregue` and `pedido_chargeback` carry IDENTICAL
 * `aprovado` / `cancelado` / `final` flags, `pagamento_em_disputa`,
 * `pedido_chargeback` and `pagamento_devolvido_sem_retorno` are all
 * `aprovado: true`, and `cancelamento_solicitado` is `cancelado: true` while not
 * final. The numeric `id` beside each codigo is diagnostic only.
 *
 * The 16 codigos are the platform's whole catalogue as both stores' read-only
 * captures returned it (`GET /v1/situacao`, capture C3): no custom situação.
 *
 * ## The payment-status vocabulary is the repo's own
 *
 * `STATUS_PAGAMENTO` is shared by every channel, and this table follows the
 * convention Mercado Livre (`orderStatusMaps.ts`) and Mercado Pago
 * (`mapping/payment.ts`) already share: `in_process` → `em_revisao`,
 * `in_mediation` → `em_disputa`, `refunded` → `estornado`, `charged_back` →
 * `devolvido`. So `pagamento_em_analise` is `em_revisao` (estado `emAnalise`),
 * `pagamento_em_disputa` is `em_disputa`, `pagamento_devolvido` and
 * `pagamento_devolvido_sem_retorno` are `estornado`, and `pedido_chargeback` is
 * `devolvido`. Every row's status maps back to its estado through
 * `statusToEstadoPedido`, except the two transition rungs that have no payment
 * meaning of their own (`pedido_efetuado`, `cancelamento_solicitado`) — pinned
 * in the test, because a pair that disagrees is relabelled by the next estado
 * reconcile.
 *
 * ## Captured or not
 *
 * Three rows answer differently by whether the payment was CAPTURED: the
 * cancellation (`pedido_cancelado`), the refund (`pagamento_devolvido`) and the
 * cancellation request (`cancelamento_solicitado`). "Captured" means the
 * order's situação history, up to the observed situação, holds a codigo in
 * {@link CODIGOS_LI_CAPTURADO}, or the observed codigo is itself one of them.
 * A dispute, a chargeback and a refund without return all presuppose a
 * captured payment, so they are capture evidence on their own; that second
 * half needs no code, because every row of a capture-evidence codigo answers
 * the same either way (pinned in the test: a row that started to depend on
 * capture would need the observed codigo counted here).
 *
 * ## What this table does NOT decide
 *
 * It gives the estado and status a NEW pedido is created at. The update rules
 * (the estado ladder, a reversal from paid refused, and the "removal applied"
 * arm where a refund keeps the stored estado and status and raises the
 * `lojaIntegradaPedidoContestado` aviso instead, because the goods may not have
 * come back) belong to the importer, which reads {@link CODIGOS_LI_ESTORNO} and
 * {@link SituacaoLi.motivoContestacao} for them.
 *
 * Pure and total: no clock, no network, no Firestore. A codigo this table does
 * not know is `null` — never an `error` estado and never an exception — and the
 * importer decides what an unknown codigo does (it keeps the order and raises
 * `lojaIntegradaSituacaoDesconhecida`). Codigos are compared EXACTLY: no trim,
 * no case fold.
 */

/** Every situação codigo of the platform's catalogue. Not a wire schema: the wire reads `z.string()`. */
export const codigoSituacaoLiSchema = z.enum([
  'pedido_efetuado',
  'aguardando_pagamento',
  'pagamento_em_analise',
  'pedido_pago',
  'faturado',
  'em_producao',
  'pedido_em_separacao',
  'pedido_enviado',
  'pronto_para_retirada',
  'pedido_entregue',
  'pagamento_em_disputa',
  'cancelamento_solicitado',
  'pedido_cancelado',
  'pagamento_devolvido',
  'pedido_chargeback',
  'pagamento_devolvido_sem_retorno',
]);
export type CodigoSituacaoLi = z.infer<typeof codigoSituacaoLiSchema>;

/** Named members of {@link codigoSituacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const CODIGO_SITUACAO_LI = {
  pedidoEfetuado: 'pedido_efetuado',
  aguardandoPagamento: 'aguardando_pagamento',
  pagamentoEmAnalise: 'pagamento_em_analise',
  pedidoPago: 'pedido_pago',
  faturado: 'faturado',
  emProducao: 'em_producao',
  pedidoEmSeparacao: 'pedido_em_separacao',
  pedidoEnviado: 'pedido_enviado',
  prontoParaRetirada: 'pronto_para_retirada',
  pedidoEntregue: 'pedido_entregue',
  pagamentoEmDisputa: 'pagamento_em_disputa',
  cancelamentoSolicitado: 'cancelamento_solicitado',
  pedidoCancelado: 'pedido_cancelado',
  pagamentoDevolvido: 'pagamento_devolvido',
  pedidoChargeback: 'pedido_chargeback',
  pagamentoDevolvidoSemRetorno: 'pagamento_devolvido_sem_retorno',
} as const satisfies Record<string, CodigoSituacaoLi>;

/** One value per capture outcome — see "Captured or not" above. */
export interface PorCapturaLi<T> {
  readonly capturado: T;
  readonly naoCapturado: T;
}

/** One row of {@link SITUACOES_LI}. */
export interface SituacaoLi {
  readonly codigo: CodigoSituacaoLi;
  /** The platform's numeric id for the codigo — diagnostic only, never a key. */
  readonly id: number;
  /** The estado a NEW pedido is created at. */
  readonly estado: PorCapturaLi<EstadoPedido>;
  /** The `status_pagamento` a NEW payment is created at. Never `null`. */
  readonly statusPagamento: PorCapturaLi<StatusPagamento>;
  /**
   * `true` only for `cancelamento_solicitado`: on an UPDATE the stored payment
   * status is kept (a request is not yet a refund); `statusPagamento` is only
   * what a payment seen for the first time is created at.
   */
  readonly mantemStatusArmazenado: boolean;
  /**
   * The `lojaIntegradaPedidoContestado` motivo this codigo raises: always for
   * the dispute; for the three refund-type codigos ({@link CODIGOS_LI_ESTORNO})
   * only on a pedido whose stock removal was applied — the importer decides
   * that arm. `null` for a codigo that never contests.
   */
  readonly motivoContestacao: MotivoPedidoContestadoLi | null;
}

function igual<T>(valor: T): PorCapturaLi<T> {
  return { capturado: valor, naoCapturado: valor };
}

/** A paid rung: the sale went through, whatever happens to the goods next. */
function pago(codigo: CodigoSituacaoLi, id: number): SituacaoLi {
  return {
    codigo,
    id,
    estado: igual(ESTADO_PEDIDO.pago),
    statusPagamento: igual(STATUS_PAGAMENTO.aprovado),
    mantemStatusArmazenado: false,
    motivoContestacao: null,
  };
}

/** A row whose estado and status do not depend on capture. */
function fixo(
  codigo: CodigoSituacaoLi,
  id: number,
  estado: EstadoPedido,
  statusPagamento: StatusPagamento,
  motivoContestacao: MotivoPedidoContestadoLi | null = null,
): SituacaoLi {
  return {
    codigo,
    id,
    estado: igual(estado),
    statusPagamento: igual(statusPagamento),
    mantemStatusArmazenado: false,
    motivoContestacao,
  };
}

/** A cancellation or refund: captured ⇒ the sale is reversed, else it never happened. */
function reverte(
  codigo: CodigoSituacaoLi,
  id: number,
  motivoContestacao: MotivoPedidoContestadoLi | null,
): SituacaoLi {
  return {
    codigo,
    id,
    estado: {
      capturado: ESTADO_PEDIDO.estornadoIntegralmente,
      naoCapturado: ESTADO_PEDIDO.cancelado,
    },
    statusPagamento: {
      capturado: STATUS_PAGAMENTO.estornado,
      naoCapturado: STATUS_PAGAMENTO.cancelado,
    },
    mantemStatusArmazenado: false,
    motivoContestacao,
  };
}

const C = CODIGO_SITUACAO_LI;

/**
 * The table, keyed by codigo. Read it through {@link situacaoLi} (an exact,
 * prototype-safe lookup of a wire string), never by indexing with one.
 */
export const SITUACOES_LI: Readonly<Record<CodigoSituacaoLi, SituacaoLi>> = {
  // Before payment. `pedido_efetuado` is the cart rung; the two awaiting rungs
  // RESERVE stock (both estados are in ESTADOS_PEDIDO_RESERVA).
  [C.pedidoEfetuado]: fixo(C.pedidoEfetuado, 9, ESTADO_PEDIDO.carrinho, STATUS_PAGAMENTO.pendente),
  [C.aguardandoPagamento]: fixo(
    C.aguardandoPagamento,
    2,
    ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    STATUS_PAGAMENTO.pendente,
  ),
  [C.pagamentoEmAnalise]: fixo(
    C.pagamentoEmAnalise,
    3,
    ESTADO_PEDIDO.emAnalise,
    STATUS_PAGAMENTO.em_revisao,
  ),

  // Paid — `pago` is the ceiling of every marketplace path: from there on the
  // estado belongs to the business, not to the channel.
  [C.pedidoPago]: pago(C.pedidoPago, 4),
  [C.faturado]: pago(C.faturado, 1018),
  [C.emProducao]: pago(C.emProducao, 17),
  [C.pedidoEmSeparacao]: pago(C.pedidoEmSeparacao, 15),
  [C.pedidoEnviado]: pago(C.pedidoEnviado, 11),
  [C.prontoParaRetirada]: pago(C.prontoParaRetirada, 13),
  [C.pedidoEntregue]: pago(C.pedidoEntregue, 14),

  // A dispute is a HOLD, not a reversal: the order stays paid, the payment is
  // `em_disputa` (still counted as paid), and the aviso says so.
  [C.pagamentoEmDisputa]: fixo(
    C.pagamentoEmDisputa,
    6,
    ESTADO_PEDIDO.pago,
    STATUS_PAGAMENTO.em_disputa,
    MOTIVO_PEDIDO_CONTESTADO_LI.disputa,
  ),

  // A cancellation REQUEST is not yet a cancellation: `processandoCancelamento`,
  // and an update keeps the stored payment status.
  [C.cancelamentoSolicitado]: {
    codigo: C.cancelamentoSolicitado,
    id: 1019,
    estado: igual(ESTADO_PEDIDO.processandoCancelamento),
    statusPagamento: {
      capturado: STATUS_PAGAMENTO.aprovado,
      naoCapturado: STATUS_PAGAMENTO.pendente,
    },
    mantemStatusArmazenado: true,
    motivoContestacao: null,
  },

  // Reversals. A cancellation and a refund reverse a captured sale and cancel
  // an uncaptured one; a chargeback and a refund without return presuppose a
  // capture, so they always reverse.
  [C.pedidoCancelado]: reverte(C.pedidoCancelado, 8, null),
  [C.pagamentoDevolvido]: reverte(C.pagamentoDevolvido, 7, MOTIVO_PEDIDO_CONTESTADO_LI.devolvido),
  [C.pedidoChargeback]: fixo(
    C.pedidoChargeback,
    16,
    ESTADO_PEDIDO.estornadoIntegralmente,
    STATUS_PAGAMENTO.devolvido,
    MOTIVO_PEDIDO_CONTESTADO_LI.chargeback,
  ),
  [C.pagamentoDevolvidoSemRetorno]: fixo(
    C.pagamentoDevolvidoSemRetorno,
    1020,
    ESTADO_PEDIDO.estornadoIntegralmente,
    STATUS_PAGAMENTO.estornado,
    MOTIVO_PEDIDO_CONTESTADO_LI.devolvidoSemRetorno,
  ),
};

const PAGOS: readonly CodigoSituacaoLi[] = [
  C.pedidoPago,
  C.faturado,
  C.emProducao,
  C.pedidoEmSeparacao,
  C.pedidoEnviado,
  C.prontoParaRetirada,
  C.pedidoEntregue,
];

/**
 * The PAID codigos: the sale went through and nothing reverses it. The label
 * step's paid re-check accepts exactly these. A `ReadonlySet<string>`, so a
 * wire codigo is tested directly — `has` is exact.
 */
export const CODIGOS_LI_PAGO: ReadonlySet<string> = new Set<string>(PAGOS);

/**
 * The codigos that PROVE a captured payment: the paid ones, plus the dispute,
 * the chargeback and the refund without return (each presupposes money that
 * moved). Exactly the catalogue's `aprovado: true` set — pinned against the
 * capture in the test, and still never read from the flag.
 */
export const CODIGOS_LI_CAPTURADO: ReadonlySet<string> = new Set<string>([
  ...PAGOS,
  C.pagamentoEmDisputa,
  C.pedidoChargeback,
  C.pagamentoDevolvidoSemRetorno,
]);

/** The dispute codigo: a hold on a paid order. */
export const CODIGO_LI_EM_DISPUTA: CodigoSituacaoLi = C.pagamentoEmDisputa;

/**
 * The refund-type codigos: on a pedido whose stock removal was applied, the
 * importer keeps the stored estado and status and raises the contestado aviso.
 */
export const CODIGOS_LI_ESTORNO: ReadonlySet<string> = new Set<string>([
  C.pagamentoDevolvido,
  C.pedidoChargeback,
  C.pagamentoDevolvidoSemRetorno,
]);

/** The cancellation codigo. */
export const CODIGO_LI_CANCELADO: CodigoSituacaoLi = C.pedidoCancelado;

/** The cancellation-request codigo: not terminal, and the status is kept on update. */
export const CODIGO_LI_CANCELAMENTO_SOLICITADO: CodigoSituacaoLi = C.cancelamentoSolicitado;

/**
 * The row of a codigo as it arrives on the wire, or `null` when the table does
 * not know it. EXACT: `'Pedido_Pago'` and `'pedido_pago '` are unknown, and a
 * name the plain object inherits (`'toString'`, `'__proto__'`) is unknown too —
 * the lookup goes through the enum, never through a property read.
 */
export function situacaoLi(codigo: string): SituacaoLi | null {
  const conhecido = codigoSituacaoLiSchema.safeParse(codigo);
  return conhecido.success ? SITUACOES_LI[conhecido.data] : null;
}

/** What a NEW pedido and its payments are created at, for one situação. */
export interface AlvoDeCriacaoLi {
  readonly estado: EstadoPedido;
  readonly statusPagamento: StatusPagamento;
}

/**
 * The estado and payment status a NEW pedido is created at, or `null` for a
 * codigo the table does not know.
 *
 * @param capturadoNoHistorico whether the order's situação history, up to the
 *   observed situação, holds a {@link CODIGOS_LI_CAPTURADO} codigo. For a
 *   codigo that is itself capture evidence the answer is the same either way
 *   (see "Captured or not" above).
 */
export function alvoDeCriacaoLi(
  codigo: string,
  capturadoNoHistorico: boolean,
): AlvoDeCriacaoLi | null {
  const linha = situacaoLi(codigo);
  if (linha === null) return null;
  return capturadoNoHistorico
    ? { estado: linha.estado.capturado, statusPagamento: linha.statusPagamento.capturado }
    : { estado: linha.estado.naoCapturado, statusPagamento: linha.statusPagamento.naoCapturado };
}
