import { coerceToMicros } from '@delfrance/core/datetime';
import { roundReais } from '@delfrance/core/money';
import { ESTADO_PEDIDO, STATUS_PAGAMENTO } from '@delfrance/schemas';

/**
 * Pure classification for the #791 audit: which Mercado Livre pedidos sit at
 * `pago` without an approved-only payment sum that covers `valorCobrado`?
 *
 * No Firestore here — `audit.ts` owns the walk. Keeping the decision pure is
 * what makes it unit-testable in `ci.yml`, and the runtime `coerceToMicros` /
 * `roundReais` / `STATUS_PAGAMENTO` are imported rather than re-implemented so
 * there is ONE definition of "approved", "microseconds" and "cents".
 */

/**
 * Why a pedido at `pago` is not covered by its approved payments.
 *
 * Only TWO kinds, deliberately. A third — "`valorCobrado` was raised after the
 * advance by a frete re-conference" — is NOT decidable from the document as it
 * stands today: it needs the value the threshold had at advance time, and
 * nothing records that. Inventing a heuristic for it would put a confident
 * label on a guess. Every row instead carries `valorCobrado`, `somaAprovada`
 * and `somaTodos` so a human can tell the two apart from the numbers.
 */
export type PagoAuditKind =
  /**
   * Even summing EVERY pagamento regardless of status falls short. Either the
   * advance was wrong from the start — the `sumAllValores` defect (#791/O13) —
   * or `valorCobrado` was raised afterwards. Both need a human decision.
   */
  | 'never-covered'
  /**
   * Sum-of-all covers it but approved-only does not: a refund, chargeback or
   * rejection landed AFTER the advance. A business decision, not necessarily a
   * defect — the advance may well have been correct when it happened.
   */
  | 'refunded-after-pago';

export interface PagamentoResumo {
  id: string;
  valor: number;
  status_pagamento: number | null;
  /** Which subcollection path it came from — see `fonte` below. */
  fonte: 'pagamentos' | 'pagamento';
}

export interface PagoAuditRow {
  pedidoPath: string;
  kind: PagoAuditKind;
  valorCobrado: number;
  somaAprovada: number;
  somaTodos: number;
  /** `valorCobrado - somaAprovada`, rounded — how short the pedido actually is. */
  deficit: number;
  /**
   * Visible in the SAME pass, and free: a row where `ultimaModificacao` is far
   * ahead of `lastMarketplaceUpdate` is a pedido a human touched. That is the
   * exact class whose ML sync the retired clock gate used to block, so these
   * counts size #791's blast radius without a second scan.
   */
  ultimaModificacao: number | null;
  lastMarketplaceUpdate: number | null;
  /**
   * `pagamentos` (this app), `pagamento` (legacy Flutter, singular), or both.
   * A row sourced ENTIRELY from the singular path is a legacy artefact rather
   * than a defect — reading only the plural path would report it as unpaid.
   */
  fonte: 'pagamentos' | 'pagamento' | 'ambos';
  pagamentos: PagamentoResumo[];
}

function somaPorStatus(pagamentos: readonly PagamentoResumo[], apenasAprovados: boolean): number {
  return roundReais(
    pagamentos
      .filter((p) => !apenasAprovados || p.status_pagamento === STATUS_PAGAMENTO.aprovado)
      .reduce((sum, p) => sum + p.valor, 0),
  );
}

function fonteDe(pagamentos: readonly PagamentoResumo[]): PagoAuditRow['fonte'] {
  const plural = pagamentos.some((p) => p.fonte === 'pagamentos');
  const singular = pagamentos.some((p) => p.fonte === 'pagamento');
  if (plural && singular) return 'ambos';
  return singular ? 'pagamento' : 'pagamentos';
}

/**
 * `null` when the pedido is fine — not at `pago`, or the approved-only sum
 * already covers `valorCobrado`. A row otherwise.
 *
 * `valorCobrado == null` is treated as covered: there is no threshold to fall
 * short of, and #791 makes a null total block the advance outright going
 * forward, so flagging historic ones would only add noise.
 */
export function auditPedidoPago(
  pedidoPath: string,
  pedido: Record<string, unknown>,
  pagamentos: readonly PagamentoResumo[],
): PagoAuditRow | null {
  if (pedido.estado !== ESTADO_PEDIDO.pago) return null;

  const valorCobrado = typeof pedido.valorCobrado === 'number' ? pedido.valorCobrado : null;
  if (valorCobrado == null) return null;

  const alvo = roundReais(valorCobrado);
  const somaAprovada = somaPorStatus(pagamentos, true);
  if (somaAprovada >= alvo) return null;

  const somaTodos = somaPorStatus(pagamentos, false);
  const kind: PagoAuditKind = somaTodos >= alvo ? 'refunded-after-pago' : 'never-covered';

  // Coerced, not raw: legacy Flutter wrote both of these in MILLISECONDS, and
  // the report compares them to each other.
  const lastMarketplaceUpdate = coerceToMicros(pedido.lastMarketplaceUpdate);
  const ultimaModificacao = coerceToMicros(pedido.ultimaModificacao);

  return {
    pedidoPath,
    kind,
    valorCobrado: alvo,
    somaAprovada,
    somaTodos,
    deficit: roundReais(alvo - somaAprovada),
    ultimaModificacao,
    lastMarketplaceUpdate,
    fonte: fonteDe(pagamentos),
    pagamentos: [...pagamentos],
  };
}
