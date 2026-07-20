'use client';

import type { CheckoutData, FindPedidoResult } from '@/lib/checkout/loadPedidoCheckout';

/**
 * A dependency-injection seam for the checkout screen's data loading, so PR 7's
 * dev harness can drive a fully in-memory 1000-item pedido (perf + leak specs)
 * WITHOUT a staging round-trip. In production `CheckoutScreen` is rendered with
 * no fixture and calls the real `findPedidoCandidates` / `loadCheckoutData`.
 *
 * Kept intentionally tiny — just the two async seams the screen needs; the
 * harness owns fixture CONSTRUCTION (`buildFixturePedido`, PR 7).
 */
export interface CheckoutFixture {
  /** Resolve a finder text to candidates in memory (defaults to a single fixed pedido). */
  find?: (text: string) => FindPedidoResult | Promise<FindPedidoResult>;
  /** Load a pedido's full checkout data in memory. */
  load: (pedidoId: string) => CheckoutData | Promise<CheckoutData>;
}

/** Wrap a single pre-built `CheckoutData` as a fixture whose finder always resolves to it. */
export function staticFixture(data: CheckoutData): CheckoutFixture {
  return {
    find: () => ({ kind: 'one', candidate: { id: data.pedidoId, numero: data.pedido.numero } }),
    load: () => data,
  };
}
