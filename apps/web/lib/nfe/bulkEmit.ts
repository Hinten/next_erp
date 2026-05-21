'use client';

/**
 * Bulk-emit dispatch shim for the `/pedidos` TableView toolbar.
 *
 * Today this only handles the SINGLE-pedido happy path — it
 * delegates to the existing `client.emitir(pedidoId)`. When more
 * than one row is selected, it throws `NFeLoteNotImplementedError`
 * which the action's catch maps to a Mantine notification.
 *
 * The full lote port (per-pedido fan-out with skip-aprovada /
 * re-emit-rejeitada / live tallies modal) lands in a follow-up PR.
 * See:
 *   - `.old/lib/pedido/pages/pedidoTableView.dart:796-854`
 *     (`EmitirNfeAction` — toolbar action shape).
 *   - `.old/packages/pedido_nfe/lib/src/tasks.dart:59-662`
 *     (`gerarNFePedidos` — skip/re-emit/dedup logic).
 *   - `.old/lib/nfe/widgets.dart:91-141`
 *     (`EmitirNFeDialog` — live Sucesso/Falhas/Não emitidas dialog).
 */
import { notifications } from '@mantine/notifications';
import type { NFeHttpClient } from '@delfrance/integrations-nfe';
import type { Pedido } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';

import { useNFeClient } from './client';
import {
  notificationForNFeError,
  notificationForNFeResult,
} from './errors';

/**
 * Thrown when the user selects more than one pedido. The follow-up
 * PR will replace this with the real fan-out + Mantine modal.
 */
export class NFeLoteNotImplementedError extends Error {
  public readonly selected: number;
  constructor(selected: number) {
    super(
      `Emissão em lote (${selected} pedidos) ainda não implementada — Phase B.`,
    );
    this.name = 'NFeLoteNotImplementedError';
    this.selected = selected;
  }
}

/**
 * Minimum row shape the dispatcher consumes — matches the
 * `SnapshotRow<Pedido>` the TableView's `ActionConfig<Pedido>.run`
 * receives, but kept narrow here so the unit test doesn't need to
 * import the full Firestore types.
 */
interface PedidoRow {
  readonly id: string;
  readonly data: Pedido;
}

/**
 * Pure dispatcher — extracted from the React hook for unit testing.
 * Takes a client + rows, applies the "1 row fast path / N row throw"
 * decision, and returns void (notifications fire as side effects).
 *
 * Throws `NFeLoteNotImplementedError` for N > 1. Re-throws non-Error
 * values per CLAUDE.md rule #6 (programming bugs must propagate).
 */
export async function dispatchEmitirNFe(
  client: NFeHttpClient,
  rows: ReadonlyArray<PedidoRow>,
): Promise<void> {
  if (rows.length === 0) {
    // `requiresSelection: true` gates the button, but defensive
    // check for any caller that bypasses the action config.
    return;
  }
  if (rows.length > 1) {
    throw new NFeLoteNotImplementedError(rows.length);
  }
  const pedido = rows[0]!;
  try {
    const result = await client.emitir(pedido.id);
    notifications.show({
      ...notificationForNFeResult(result),
      autoClose: 8000,
    });
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    notifications.show({
      ...notificationForNFeError(err),
      autoClose: 8000,
    });
  }
}

/**
 * React hook returning the `ActionConfig<Pedido>` the TableView's
 * `actions` array consumes. The action is disabled while the user
 * is logged out (`client` is null) via `requiresSelection`'s
 * complement — actually `requiresSelection` only gates on row
 * count, so we also no-op inside `run` when `client` is null.
 *
 * The `NFeLoteNotImplementedError` throw is caught here and
 * converted to a Mantine notification so the user always sees a
 * message (not an uncaught error overlay).
 */
export function useEmitirNFeAction(): ActionConfig<Pedido> {
  const client = useNFeClient();
  return {
    id: 'emit-nfe',
    label: 'Emitir NF-e',
    color: 'teal',
    requiresSelection: true,
    refreshOnComplete: true,
    confirm: {
      title: 'Emitir NF-e',
      message: 'Emitir NF-e para o(s) pedido(s) selecionado(s)?',
    },
    run: async (rows) => {
      if (!client) {
        notifications.show({
          title: 'Sessão inválida',
          message: 'Faça login novamente para emitir NF-e.',
          color: 'red',
          autoClose: 8000,
        });
        return;
      }
      try {
        await dispatchEmitirNFe(client, rows);
      } catch (err) {
        if (err instanceof NFeLoteNotImplementedError) {
          notifications.show({
            title: 'Emissão em lote',
            message: 'Emissão em lote ainda não implementada (Phase B).',
            color: 'yellow',
            autoClose: 8000,
          });
          return;
        }
        // Non-Error or anything else: re-throw so the ActionBar
        // surfaces it (or the runtime catches it as a programming
        // bug). The single-pedido path already shows notifications
        // for typed NF-e errors inside dispatchEmitirNFe.
        throw err;
      }
    },
  };
}
