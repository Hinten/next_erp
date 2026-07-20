'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Pedido } from '@delfrance/schemas';
import type { ComprarEtiquetaInput, ComprarEtiquetaOutcome } from '@/lib/checkout/etiqueta/types';
import { EtiquetaComprarModal } from '@/app/(app)/pedidos/_components/EtiquetaComprarModal';

/**
 * Bridges the etiqueta provider's `ui.comprarEtiqueta(input)` Promise onto the
 * existing `/pedidos` `EtiquetaComprarModal`. The provider (melhorEnvios) awaits
 * this to know whether a label was bought; the modal already resolves the cart,
 * shows the ME saldo, buys, and offers an "Abrir etiqueta" button on success.
 *
 * PR-5 scope: we resolve `{ status: 'cancelled' }` when the modal closes. The
 * modal itself surfaces the bought label (its own open-label button), so the
 * provider's redundant `openUrl` is skipped and nothing re-prints the wrong
 * pedido. Wiring a "bought" outcome back through the modal (so the provider can
 * chain a print) is a PR-6 reliability follow-up — see the QUESTIONS in the PR.
 */
export interface ComprarEtiquetaBridge {
  comprarEtiqueta: (input: ComprarEtiquetaInput) => Promise<ComprarEtiquetaOutcome>;
  element: React.ReactNode;
}

interface Pending {
  input: ComprarEtiquetaInput;
  pedido: Pedido;
  resolve: (outcome: ComprarEtiquetaOutcome) => void;
}

export function useComprarEtiquetaBridge(pedido: Pedido | null): ComprarEtiquetaBridge {
  const [pending, setPending] = useState<Pending | null>(null);
  const settledRef = useRef(false);
  const pedidoRef = useRef<Pedido | null>(pedido);
  useEffect(() => {
    pedidoRef.current = pedido;
  });

  const comprarEtiqueta = useCallback((input: ComprarEtiquetaInput) => {
    return new Promise<ComprarEtiquetaOutcome>((resolve) => {
      const current = pedidoRef.current;
      if (current === null) {
        // No pedido in context (shouldn't happen post-save) — nothing to buy.
        resolve({ status: 'cancelled' });
        return;
      }
      settledRef.current = false;
      setPending({ input, pedido: current, resolve });
    });
  }, []);

  const close = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    pending?.resolve({ status: 'cancelled' });
    setPending(null);
  }, [pending]);

  const element = pending ? (
    <EtiquetaComprarModal
      opened
      onClose={close}
      pedido={pending.pedido}
      pedidoId={pending.input.pedidoId}
      intFreteId={pending.input.intFreteId}
      needsPostedConfirm={pending.input.needsPostedConfirm}
    />
  ) : null;

  return { comprarEtiqueta, element };
}
