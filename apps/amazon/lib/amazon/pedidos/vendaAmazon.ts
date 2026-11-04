/**
 * The sale state (master plan step 5, PR 5-c; D17): the signals read from the
 * INCOMING order and the STORED pedido. The D17 table that reads them
 * (`regraD17Amazon`, top-down, first match wins) lives beside the line
 * reconciliation in `itensAmazon.ts`, so this module depends on that one and
 * never the reverse.
 *
 * Signals (plan "The sale state"):
 * - `C` — `fulfillmentStatus === 'CANCELLED'`;
 * - `X` — some line carries `cancellation.cancellationExecution`;
 * - `R` — some line carries `cancellationRequest`, no line an execution, and not `C`
 *   (`solicitacaoAberta` is the raw per-line "a request is open", read only by
 *   `cancelado-so-no-erp`);
 * - `P` — some package's `detailedStatus` reverses the sale
 *   (`DETAILED_STATUS_REVERSAO`, imported — never a second list here);
 * - `Z` — `SHIPPED` and the lines arrive zeroed, emptied or short, or (PR 6)
 *   the payment arrives summing to 0 while the stored pagamento's is positive;
 * - the phase: `pre` (PENDING, PENDING_AVAILABILITY), `apr` (UNSHIPPED,
 *   PARTIALLY_SHIPPED), `env` (SHIPPED), `cancelado`, `desconhecida` (absent,
 *   unknown, UNFULFILLABLE);
 * - `rev` (reversed) = `C` ∨ `P` ∨ (`X` ∧ `env`) ∨ `Z`.
 *
 * From the STORED snapshot: `aprovado` (`aprovadoAmazon`), `congelado`
 * (`hasUserInteraction === true`), `impresso` (the print stamp).
 *
 * ## ⚠️ In that table the reversal rows come BEFORE the first-seen and approval-moment rows
 *
 * So no reversed order is ever created at `pago`, and none is mirrored with
 * zeros. A first-seen reversed order is not imported at all (rows 2 and 3, plan
 * §3 decision 44).
 */
import type { PedidoWireAmazon } from '@delfrance/integrations-amazon-sp-api';

import {
  FULFILLMENT_STATUS_AMAZON,
  aprovadoAmazon,
  type ResumoArmazenadoAmazon,
} from './estadoPedidoAmazon';
import { linhasRecebidasAmazon, type LinhaArmazenadaAmazon } from './itensAmazon';
import { ehDetailedStatusReversao } from './pacotesAmazon';
import { execucoesPagamentoAmazon, somaPagamentoAmazon } from './pagamentoAmazon';

/** The order's phase, from `fulfillmentStatus` alone. */
export type FaseVendaAmazon = 'pre' | 'apr' | 'env' | 'cancelado' | 'desconhecida';

/** `fulfillmentStatus` → the phase (exact match; anything else `desconhecida`). */
export function faseVendaAmazon(status: string | null | undefined): FaseVendaAmazon {
  switch (status) {
    case FULFILLMENT_STATUS_AMAZON.pending:
    case FULFILLMENT_STATUS_AMAZON.pendingAvailability:
      return 'pre';
    case FULFILLMENT_STATUS_AMAZON.unshipped:
    case FULFILLMENT_STATUS_AMAZON.partiallyShipped:
      return 'apr';
    case FULFILLMENT_STATUS_AMAZON.shipped:
      return 'env';
    case FULFILLMENT_STATUS_AMAZON.cancelled:
      return 'cancelado';
    case null:
    case undefined:
    default:
      return 'desconhecida';
  }
}

/** The sale state one import decides on. */
export interface VendaAmazon {
  readonly fase: FaseVendaAmazon;
  /** C */
  readonly cancelado: boolean;
  /** X */
  readonly execucao: boolean;
  /** R — a cancellation REQUEST alone (never a reversal for blocking purposes). */
  readonly solicitacao: boolean;
  /**
   * Some line carries a request its OWN execution has not closed, whatever the
   * other lines carry. Unlike R, an execution on another line does not hide it:
   * this is "a request is open" for `cancelado-so-no-erp`, never the R branch.
   */
  readonly solicitacaoAberta: boolean;
  /** P */
  readonly reversaoPacote: boolean;
  /** Z */
  readonly zerado: boolean;
  /** rev = C ∨ P ∨ (X ∧ env) ∨ Z */
  readonly revertido: boolean;
  /** No stored pedido. */
  readonly primeiraVez: boolean;
  /** The STORED pedido is approved (`false` on a create). */
  readonly aprovado: boolean;
  /** The STORED pedido was edited by an operator (`false` on a create). */
  readonly congelado: boolean;
  /** The STORED pedido slip was printed (`false` on a create). */
  readonly impresso: boolean;
}

/** What the classifier reads from the stored pedido. */
export interface PedidoArmazenadoVendaAmazon {
  readonly resumo: ResumoArmazenadoAmazon;
  readonly linhas: readonly LinhaArmazenadaAmazon[];
  /** The stored pagamento's `valor` (a finite number), or `null` (none, or unreadable). */
  readonly pagamentoValor: number | null;
}

function zeroOuAusente(valor: number | null): boolean {
  return valor === null || valor === 0;
}

function positivo(valor: number | null): boolean {
  return valor !== null && valor > 0;
}

/**
 * "Zeroed, emptied or short" (Z), only on `SHIPPED`: `orderItems` absent or
 * `[]`; with a stored pedido, a stored `mktplaceId` missing from the incoming
 * lines, or a matched line whose incoming quantity or unit price is 0 or absent
 * while the stored one is positive; with none stored, a line whose quantity or
 * unit price is 0 or absent; and (PR 6) the incoming Σ of payment executions 0,
 * absent or unreadable while the stored pagamento's `valor` is positive.
 */
function zerado(
  order: PedidoWireAmazon,
  fase: FaseVendaAmazon,
  armazenado: PedidoArmazenadoVendaAmazon | null,
): boolean {
  if (fase !== 'env') return false;
  const recebidas = linhasRecebidasAmazon(order);
  if (recebidas.length === 0) return true;
  if (armazenado === null) {
    return recebidas.some((l) => zeroOuAusente(l.quantidade) || zeroOuAusente(l.precoUnitario));
  }
  if (positivo(armazenado.pagamentoValor)) {
    const soma = somaPagamentoAmazon(execucoesPagamentoAmazon(order));
    if (soma === null || soma === 0) return true;
  }
  const porId = new Map(recebidas.map((l) => [l.orderItemId, l]));
  return armazenado.linhas.some((guardada) => {
    if (guardada.mktplaceId === null) return false;
    const recebida = porId.get(guardada.mktplaceId);
    if (recebida === undefined) return true;
    return (
      (zeroOuAusente(recebida.quantidade) && positivo(guardada.quantidade)) ||
      (zeroOuAusente(recebida.precoUnitario) && positivo(guardada.precoDeVenda))
    );
  });
}

/** The sale state (module header). Throws only what `linhasRecebidasAmazon` throws. */
export function classificarVendaAmazon(
  order: PedidoWireAmazon,
  armazenado: PedidoArmazenadoVendaAmazon | null,
): VendaAmazon {
  const fase = faseVendaAmazon(order.fulfillment?.fulfillmentStatus);
  const linhas = order.orderItems ?? [];
  const cancelado = fase === 'cancelado';
  const execucao = linhas.some((l) => l.cancellation?.cancellationExecution != null);
  const pedido = linhas.some((l) => l.cancellation?.cancellationRequest != null);
  const solicitacao = pedido && !execucao && !cancelado;
  const solicitacaoAberta = linhas.some(
    (l) =>
      l.cancellation?.cancellationRequest != null && l.cancellation.cancellationExecution == null,
  );
  const reversaoPacote = (order.packages ?? []).some((p) =>
    ehDetailedStatusReversao(p.packageStatus?.detailedStatus),
  );
  const z = zerado(order, fase, armazenado);
  return {
    fase,
    cancelado,
    execucao,
    solicitacao,
    solicitacaoAberta,
    reversaoPacote,
    zerado: z,
    revertido: cancelado || reversaoPacote || (execucao && fase === 'env') || z,
    primeiraVez: armazenado === null,
    aprovado: armazenado !== null && aprovadoAmazon(armazenado.resumo),
    congelado: armazenado?.resumo.congelado === true,
    impresso: armazenado?.resumo.impresso === true,
  };
}
