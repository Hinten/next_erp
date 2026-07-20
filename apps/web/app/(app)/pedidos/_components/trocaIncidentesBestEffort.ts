'use client';

/**
 * Best-effort wrapper around `registrarIncidentesDeTroca`, shared by the
 * create (#488) and edit re-save flows: the pedido is already committed when
 * this runs, so a failed incidente write (e.g. a rules gap) must never block
 * the flow or the navigation — warn with a yellow toast and move on. Only
 * `FirebaseError` is swallowed; anything else rethrows.
 */
import { FirebaseError } from 'firebase/app';
import { notifications } from '@mantine/notifications';
import { registrarIncidentesDeTroca, type PedidoDataPort } from '@delfrance/data/pedido';

export async function registrarIncidentesDeTrocaBestEffort(
  port: PedidoDataPort,
  args: {
    saidaPedidoId: string;
    saidaNumero: string | null;
    originIds: ReadonlyArray<string>;
  },
): Promise<void> {
  try {
    await registrarIncidentesDeTroca(port, args);
  } catch (err) {
    if (!(err instanceof FirebaseError)) throw err;
    notifications.show({
      color: 'yellow',
      message:
        'Pedido salvo, mas os incidentes de troca não puderam ser registrados nos pedidos de origem.',
    });
  }
}
