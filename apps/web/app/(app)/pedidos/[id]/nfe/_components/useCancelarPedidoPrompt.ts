'use client';

/**
 * Post-cancelamento prompt: after an NF-e cancelamento is homologated, offer to
 * also cancel the pedido (#74, legacy `cancelamentoNFe.dart:229-261`).
 *
 * The hook — rather than the inline form — owns the dialog **on purpose**.
 * `POST /api/nfe/cancelar` persists `estado: 'c'` before it answers, so by the
 * time `client.cancelar()` resolves the NF-e screen's `onSnapshot` is already
 * delivering `cancelada` and the `CancelarNFeForm` (rendered only while the
 * NF-e is aprovada) unmounts. A dialog owned by the form would be torn down
 * with it and its `confirm()` promise would never settle — the operator would
 * never see the prompt. Owned by the page, which stays mounted, it survives.
 *
 * Mirrors `pedidos/_components/useEmitirEntradaPrompt`, the other post-action
 * prompt in this codebase.
 */
import type { ReactNode } from 'react';
import { FirebaseError } from 'firebase/app';
import { notifications } from '@mantine/notifications';
import { cancelarPedido } from '@delfrance/data/pedido';

import { createClientPedidoPort } from '@/lib/pedidos/clientPort';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useConfirmDialog } from '@/app/(app)/pedidos/_components/ConfirmDialog';

export interface UseCancelarPedidoPromptResult {
  /** Await after a homologated NF-e cancelamento; resolves once the flow is done. */
  promptCancelarPedido: (pedidoId: string) => Promise<void>;
  /** Render once in the view that owns the hook (the confirm dialog). */
  element: ReactNode;
}

export function useCancelarPedidoPrompt(): UseCancelarPedidoPromptResult {
  const { confirm, element } = useConfirmDialog();

  async function promptCancelarPedido(pedidoId: string): Promise<void> {
    const cancelarTambem = await confirm({
      title: 'Cancelar pedido?',
      message: 'Também deseja cancelar o pedido?',
    });
    if (!cancelarTambem) return;
    try {
      await cancelarPedido(createClientPedidoPort(getFirebaseFirestore()), { pedidoId });
    } catch (err) {
      if (!(err instanceof FirebaseError)) throw err;
      // Do not assert the pedido stayed unchanged: the estado write may well
      // have landed, and the `onPedidoChanged` trigger appends the
      // história row from it. Just point the operator at the pedido.
      notifications.show({
        color: 'yellow',
        message: 'Não foi possível confirmar o cancelamento do pedido — verifique o pedido.',
      });
    }
  }

  return { promptCancelarPedido, element };
}
