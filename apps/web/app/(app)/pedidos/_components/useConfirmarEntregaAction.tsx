'use client';

/**
 * "Confirmar entrega" row action for `/pedidos` and `/pedidos/entradas` (#549)
 * — port of the legacy `ConfirmarEntrega` action
 * (`.old/lib/pedido/pages/pedidoTableView.dart:1708-1785`).
 *
 * Only allowed while a pedido is `emProcessamento` or `pago`: marks
 * `freteInicial.estado = entregue` (synthesizing a `semFrete` block first when
 * the pedido has none) and moves the pedido `estado` to `finalizado`. Both
 * fields live on the SAME `pedidos/{id}` document, so one `merge()` per
 * pedido does it — the `historicoEstadoPedido` / `historicoFtIni` audit rows
 * are recorded automatically by the server-side `onPedidoChanged` trigger
 * (CLAUDE.md rule 6 / `no-client-estado-history-write`: this app must never
 * write those subcollections directly). Reaching `finalizado` also drives
 * stock removal server-side (`sincronizarEstoquePedido`) — not duplicated
 * here.
 */
import { useMemo } from 'react';
import { notifications } from '@mantine/notifications';
import { IconTruckDelivery } from '@tabler/icons-react';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  MODALIDADE_FRETE,
  seedFreteInicial,
  type EstadoPedido,
  type Pedido,
} from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';

import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';

/**
 * The only two estados a pedido may be confirmed-delivered from (#549's
 * guard). Every other estado — including `cancelado`/`estornado*`/`fraude` —
 * is refused with a clear message rather than silently no-op'd.
 */
const ESTADOS_CONFIRMAVEIS: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  ESTADO_PEDIDO.emProcessamento,
  ESTADO_PEDIDO.pago,
]);

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
        const db = getFirebaseFirestore();

        // Re-read fresh docs rather than trusting `row.data`: TableView's
        // Pipeline projection only guarantees the columns currently visible,
        // and the guard + freteInicial synthesis below need the real stored
        // estado/freteInicial, not a stale or partially-projected one
        // (mirrors `useEnviarEstoqueAction`). `source: 'server'` because the
        // result feeds a write — an offline/cache miss must reject, not read
        // as "pedido not found".
        const frescos = await getDocsByIds(
          db,
          pedidoCollection,
          rows.map((r) => r.id),
          {},
          { source: 'server' },
        );

        const bloqueados: string[] = [];
        const alvos: Array<{ id: string; pedido: Pedido }> = [];
        for (const row of rows) {
          const pedido = frescos.get(row.id);
          if (!pedido || !ESTADOS_CONFIRMAVEIS.has(pedido.estado)) {
            bloqueados.push(pedido?.numero ?? row.id);
            continue;
          }
          alvos.push({ id: row.id, pedido });
        }

        if (bloqueados.length > 0) {
          notifications.show({
            color: 'yellow',
            message:
              'Só é possível confirmar a entrega de pedidos Em processamento ou Pago. ' +
              `Pedido(s) bloqueado(s): ${bloqueados.join(', ')}.`,
          });
        }
        if (alvos.length === 0) return;

        const resultados = await Promise.allSettled(
          alvos.map(({ id, pedido }) => {
            // Synthesize a `semFrete` (sem transporte) block when the pedido
            // has none — legacy parity (#549) — otherwise preserve the
            // existing block and only move its `estado`. Every live writer
            // of `freteInicial` replaces the WHOLE block (never a dotted
            // patch — see `buildFreteHistoryEntry`), so this does too.
            const freteAtual =
              pedido.freteInicial ??
              seedFreteInicial(MODALIDADE_FRETE.semTransporte, pedido.ehSaida);
            return pedidoCollection.merge(db, {}, id, {
              estado: ESTADO_PEDIDO.finalizado,
              freteInicial: { ...freteAtual, estado: ESTADO_FRETE.entregue },
            });
          }),
        );

        const falhas = resultados.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        ).length;
        if (falhas > 0) {
          showErrorNotification({
            title: 'Confirmar entrega',
            message:
              falhas === alvos.length
                ? 'Não foi possível confirmar a entrega dos pedidos selecionados.'
                : `${String(alvos.length - falhas)} pedido(s) confirmado(s); ${String(falhas)} falha(s).`,
          });
          return;
        }

        notifications.show({
          color: 'green',
          message:
            alvos.length === 1
              ? 'Entrega confirmada.'
              : `${String(alvos.length)} pedido(s) confirmado(s) como entregue(s).`,
        });
      },
    }),
    [],
  );

  return { action };
}
