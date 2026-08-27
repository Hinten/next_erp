/**
 * Who owns `pedido.valorCobrado` right now, and what a reconciliation may
 * legitimately call a finding — the pure half of `scripts/inspect-pedido.ts`.
 *
 * ⚠️ **This module exists because a diagnostic that reconciles against the
 * wrong formula manufactures findings**, and the #1087 live run lost an hour to
 * exactly that. `valorCobrado` has two writers:
 *
 *  - **the seed** (`mlOrderToPedidoCoreFields` → `orderPedidoTx`):
 *    `Σ transaction_amount + Σ shipping_cost − Σ coupon_amount`, written ONCE at
 *    create and, on a **pack**, computed from `orders[0]` ALONE;
 *  - **the frete conference** (`applyFreteStep`): the canonical
 *    `derivePedidoFreteTotals`, `Σ itemSubtotal − descontoTotal + frete`, from
 *    the first shipment payload onward — the legacy meaning of the field,
 *    `Pedido.total`, "valor final cobrado no pedido".
 *
 * The discriminator is the frete block: no `freteInicial` ⇒ the conference has
 * not run ⇒ the seed is still the owner. Judging such a pedido by the
 * conference's formula reports a shortfall of exactly the freight on a document
 * whose money is entirely correct.
 *
 * Pure — no Firestore, no IO, no clock.
 */
import { roundReais } from '@delfrance/core/money';
import { derivePedidoFreteTotals, type ItemDoPedido } from '@delfrance/schemas';

/** Reais agree to the cent. */
function bate(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

/** The frete money fields the totals read; `null` = no block yet. */
export interface FreteMoney {
  valorCobrado: number | null;
  custoCalculado: number | null;
  custoFinal: number | null;
}

export type VeredictoValorCobrado =
  /** Stored matches the owner's formula. */
  | { readonly tipo: 'confere' }
  /** Nothing stored — the advance to `pago` refuses a null total (#791). */
  | { readonly tipo: 'ausente' }
  /**
   * Off by exactly `descontoTotal`.
   *
   * ⚠️ Kept as a GUARD, not as a live expectation. `applyFreteStep` used to omit
   * the coupon term the canonical derive has; it no longer does, so on current
   * code this verdict cannot fire from that cause. It stays because a pedido
   * written by the OLD code is still on disk with the old total, and because
   * whether the term belongs there at all is unsettled until LIVE-TEST §7.1
   * step 6.3 says who funds an ML coupon — if the answer reverts the term, this
   * is the branch that keeps the reconciliation honest instead of noisy.
   */
  | { readonly tipo: 'diferenca-conhecida'; readonly descontoTotal: number }
  /** A real finding: a gap that is neither zero nor the coupon. */
  | { readonly tipo: 'achado'; readonly gap: number };

export interface AuditoriaValorCobrado {
  /** Which writer owns the field right now. */
  readonly dono: 'semente' | 'conferencia';
  /** What the owner's formula says it should be. */
  readonly esperado: number;
  readonly veredicto: VeredictoValorCobrado;
  /** Both formulas, always — the one that is not the owner is context. */
  readonly semente: number;
  readonly canonico: number;
}

/**
 * `Σ transaction_amount + Σ shipping_cost − Σ coupon_amount`, the create-time
 * seed. ⚠️ On a pack the WRITER used `orders[0]` alone, so a caller summing the
 * whole `orderML` mirror is computing a different quantity — see `ehPack` on
 * `auditarDescontoTotal`.
 */
export function sementeValorCobrado(args: {
  totalTransacoes: number;
  totalShippingCost: number;
  totalCupom: number;
}): number {
  return roundReais(args.totalTransacoes + args.totalShippingCost - args.totalCupom);
}

export function auditarValorCobrado(args: {
  valorCobradoArmazenado: unknown;
  itens: readonly ItemDoPedido[];
  descontoTotal: number;
  frete: FreteMoney | null;
  totalTransacoes: number;
  totalShippingCost: number;
  totalCupom: number;
}): AuditoriaValorCobrado {
  const { valorCobradoArmazenado, itens, descontoTotal, frete } = args;

  const semente = sementeValorCobrado(args);
  const canonico = derivePedidoFreteTotals({
    itens,
    descontoTotal,
    freteInicial: frete,
  }).valorCobrado;

  // The whole point of the module, in one line.
  const dono = frete == null ? 'semente' : 'conferencia';
  const esperado = dono === 'semente' ? semente : canonico;

  if (typeof valorCobradoArmazenado !== 'number' || !Number.isFinite(valorCobradoArmazenado)) {
    return { dono, esperado, veredicto: { tipo: 'ausente' }, semente, canonico };
  }
  if (bate(valorCobradoArmazenado, esperado)) {
    return { dono, esperado, veredicto: { tipo: 'confere' }, semente, canonico };
  }
  const gap = roundReais(valorCobradoArmazenado - esperado);
  // Only the conference can produce the coupon gap — the seed subtracts the
  // coupon itself, so an off-by-descontoTotal there is a genuine finding. See
  // the type's note: on current code this is a legacy/unsettled guard, not a
  // live expectation.
  if (dono === 'conferencia' && descontoTotal !== 0 && bate(gap, descontoTotal)) {
    return {
      dono,
      esperado,
      veredicto: { tipo: 'diferenca-conhecida', descontoTotal },
      semente,
      canonico,
    };
  }
  return { dono, esperado, veredicto: { tipo: 'achado', gap }, semente, canonico };
}

export type VeredictoDescontoTotal =
  | { readonly tipo: 'confere' }
  | { readonly tipo: 'ausente' }
  | { readonly tipo: 'diverge'; readonly recalculado: number }
  /**
   * ⚠️ A pack gets NO verdict. `descontoTotal` is written once at create from
   * `orders[0]` alone and never recomputed, while a reconciliation sums every
   * order in the `orderML` mirror — so on a pack whose sibling carried a coupon
   * the two disagree BY DESIGN, and calling that a divergence is a phantom.
   */
  | { readonly tipo: 'sem-veredito-pack'; readonly somaDoPack: number };

export function auditarDescontoTotal(args: {
  descontoTotalArmazenado: unknown;
  totalCupom: number;
  ehPack: boolean;
}): VeredictoDescontoTotal {
  const { descontoTotalArmazenado, ehPack } = args;
  const totalCupom = roundReais(args.totalCupom);
  if (ehPack) return { tipo: 'sem-veredito-pack', somaDoPack: totalCupom };
  if (typeof descontoTotalArmazenado !== 'number' || !Number.isFinite(descontoTotalArmazenado)) {
    return { tipo: 'ausente' };
  }
  return bate(descontoTotalArmazenado, totalCupom)
    ? { tipo: 'confere' }
    : { tipo: 'diverge', recalculado: totalCupom };
}
