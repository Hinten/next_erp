'use client';

/**
 * "Confirmar entrega" row action for `/pedidos` and `/pedidos/entradas`
 * (#549) — port of the legacy `ConfirmarEntrega` action
 * (`.old/lib/pedido/pages/pedidoTableView.dart:1708-1785`).
 *
 * Thin UI wrapper over `confirmarEntregaPedido` (`@delfrance/data/pedido`),
 * which does the actual guard + write: only a pedido currently
 * `emProcessamento`/`pago` is confirmed (`freteInicial.estado → entregue`,
 * synthesizing a `semFrete` block when absent, `estado → finalizado`);
 * everything else resolves `'bloqueado'` with no write. Routed through
 * `createClientPedidoPort`'s `updatePedido` — the SAME transactional
 * read-modify-write primitive `cancelarPedido`/`savePedido` use — so the
 * guard and the freteInicial merge always act on the doc as it is AT WRITE
 * TIME, never a value read before it: a concurrent write (another operator's
 * save, a Melhor Envio tracking update, an ML sync) can't be silently
 * clobbered (root `CLAUDE.md` rule 7). The `historicoEstadoPedido` /
 * `historicoFtIni` audit rows are recorded by the server-side
 * `onPedidoChanged` trigger observing that write — never appended here
 * (CLAUDE.md rule 6 / `no-client-estado-history-write`). Reaching
 * `finalizado` also drives stock removal server-side
 * (`sincronizarEstoquePedido`) — not duplicated here.
 */
import { useMemo } from 'react';
import { notifications } from '@mantine/notifications';
import { IconTruckDelivery } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { confirmarEntregaPedido } from '@delfrance/data/pedido';
import type { Pedido } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';

import { createClientPedidoPort } from '@/lib/pedidos/clientPort';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';

export function useConfirmarEntregaAction(): { readonly action: ActionConfig<Pedido> } {
  const action = useMemo<ActionConfig<Pedido>>(
    () => ({
      id: 'confirmar-entrega',
      label: 'Confirmar entrega',
      color: 'green',
      icon: <IconTruckDelivery size={16} />,
      requiresSelection: true,
      // estado + freteInicial.estado both move — the Pagamento and Frete
      // columns must reflect it.
      refreshOnComplete: true,
      confirm: {
        title: 'Confirmar entrega',
        message: 'Marcar o(s) pedido(s) selecionado(s) como entregue(s) e finalizado(s)?',
      },
      run: async (rows) => {
        if (rows.length === 0) return;
        const port = createClientPedidoPort(getFirebaseFirestore());

        const resultados = await Promise.allSettled(
          rows.map((row) =>
            confirmarEntregaPedido(port, { pedidoId: row.id }).then((resultado) => ({
              row,
              resultado,
            })),
          ),
        );

        const bloqueados: string[] = [];
        let confirmados = 0;
        for (const r of resultados) {
          if (r.status !== 'fulfilled') continue;
          if (r.value.resultado === 'bloqueado') {
            bloqueados.push(r.value.row.data.numero ?? r.value.row.id);
          } else {
            confirmados += 1;
          }
        }
        // Anything that REJECTED (a genuine write failure, not the estado
        // guard — that resolves 'bloqueado' above, per `useCancelarPedidoPrompt`'s
        // same narrowing) — only a `FirebaseError` is a reportable failure;
        // anything else is a bug and must surface (CLAUDE.md rule 6).
        const falhas = resultados.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        for (const f of falhas) {
          if (!(f.reason instanceof FirebaseError)) throw f.reason;
        }

        if (bloqueados.length > 0) {
          notifications.show({
            color: 'yellow',
            message:
              'Só é possível confirmar a entrega de pedidos Em processamento ou Pago. ' +
              `Pedido(s) bloqueado(s): ${bloqueados.join(', ')}.`,
          });
        }
        if (falhas.length > 0) {
          showErrorNotification({
            title: 'Confirmar entrega',
            message:
              confirmados > 0
                ? `${String(confirmados)} pedido(s) confirmado(s); ${String(falhas.length)} falha(s).`
                : 'Não foi possível confirmar a entrega dos pedidos selecionados.',
          });
        } else if (confirmados > 0) {
          notifications.show({
            color: 'green',
            message:
              confirmados === 1
                ? 'Entrega confirmada.'
                : `${String(confirmados)} pedido(s) confirmado(s) como entregue(s).`,
          });
        }
      },
    }),
    [],
  );

  return { action };
}
