'use client';

/**
 * Bulk-emit dispatch shim for the `/pedidos` TableView toolbar.
 *
 * Two paths:
 *  - 1 selected pedido → `client.emitir(pedidoId)` + Mantine
 *    notification (legacy single-pedido fast path).
 *  - N > 1 selected pedidos → open the `EmitirLoteDialog` which
 *    fires `client.emitirLote(pedidoIds)` and renders a three-counter
 *    summary mirroring Flutter's `EmitirNFeDialog`.
 *
 * The dispatcher (`dispatchEmitirNFe`) stays a pure async function
 * so the existing unit tests at `bulkEmit.test.ts` keep their
 * coverage of the single-pedido happy path + the N>1 contract.
 *
 * Source-of-truth Flutter references:
 *   - `.old/lib/pedido/pages/pedidoTableView.dart:796-854`
 *     (`EmitirNfeAction` — toolbar action shape).
 *   - `.old/packages/pedido_nfe/lib/src/tasks.dart:59-662`
 *     (`gerarNFePedidos` — backend fan-out).
 *   - `.old/lib/nfe/widgets.dart:91-141`
 *     (`EmitirNFeDialog` — three-counter dialog).
 */
import { useState } from 'react';
import { notifications } from '@mantine/notifications';
import type { NFeHttpClient } from '@delfrance/integrations-nfe/http-provider';
import type { Pedido } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';

import { useNFeClient } from './client';
import { notificationForNFeError, notificationForNFeResult } from './errors';
import {
  showCopyableNotification,
  showErrorNotification,
} from '../notifications/showErrorNotification';

/**
 * Thrown when N>1 pedidos are dispatched through the legacy
 * single-pedido path. Kept so the unit tests at `bulkEmit.test.ts`
 * still assert the dispatcher's "1 row only" contract. In the live
 * code path the React hook routes N>1 to the modal BEFORE this
 * throws.
 */
export class NFeLoteNotImplementedError extends Error {
  public readonly selected: number;
  constructor(selected: number) {
    super(
      `Emissão em lote (${selected} pedidos) deve usar o EmitirLoteDialog, não dispatchEmitirNFe.`,
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
 * Single-pedido path only; N>1 throws `NFeLoteNotImplementedError`
 * so the caller (React hook) knows to open the dialog instead.
 */
export async function dispatchEmitirNFe(
  client: NFeHttpClient,
  rows: ReadonlyArray<PedidoRow>,
): Promise<void> {
  if (rows.length === 0) return;
  if (rows.length > 1) {
    throw new NFeLoteNotImplementedError(rows.length);
  }
  const pedido = rows[0]!;
  try {
    const result = await client.emitir(pedido.id);
    // Copyable toast — SEFAZ outcomes (cStat/xMotivo, e.g. the EPEC 468
    // "não sincronizado" wait-and-retry) need to be copy-pasteable for
    // diagnosis, exactly like the error path below.
    showCopyableNotification(notificationForNFeResult(result));
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    showErrorNotification(notificationForNFeError(err));
  }
}

/**
 * Lote-modal state exposed by `useEmitirNFeAction`. The page renders
 * `<EmitirLoteDialog>` and binds these props.
 */
export interface EmitirLoteModalState {
  readonly opened: boolean;
  readonly pedidoIds: ReadonlyArray<string>;
  readonly close: () => void;
}

/**
 * React hook returning the `ActionConfig<Pedido>` the TableView's
 * `actions` array consumes, plus the modal state the page binds to
 * `<EmitirLoteDialog>`. For N>1 selections the action's `run`
 * callback opens the modal instead of throwing.
 */
export function useEmitirNFeAction(): {
  readonly action: ActionConfig<Pedido>;
  readonly loteModal: EmitirLoteModalState;
} {
  const client = useNFeClient();
  const [loteState, setLoteState] = useState<{
    opened: boolean;
    pedidoIds: ReadonlyArray<string>;
  }>({ opened: false, pedidoIds: [] });

  const action: ActionConfig<Pedido> = {
    id: 'emit-nfe',
    label: 'Emitir NF-e',
    color: 'teal',
    requiresSelection: true,
    // No `refreshOnComplete`: the NF column (`NFCell`) is a live `onSnapshot` on
    // `pedidos/{id}/nfev4`, so it reflects the new estado on its own. A table-wide
    // re-query here would only flash the list to skeletons and drop the selection
    // — and for a lote it fires before emission even finishes (the dialog returns
    // immediately). So leave the table alone (#259).
    //
    // Still true after #1216: the listener is gated on the row being on screen,
    // and a row the operator just selected for emission is by definition on
    // screen. A row scrolled far away resubscribes — and repaints from the
    // `useLatestNfe` memo — when it comes back.
    confirm: {
      title: 'Emitir NF-e',
      message: 'Emitir NF-e para o(s) pedido(s) selecionado(s)?',
    },
    run: async (rows) => {
      if (!client) {
        showErrorNotification({
          title: 'Você não está logado',
          message: 'Faça login para emitir NF-e.',
        });
        return;
      }
      if (rows.length > 1) {
        setLoteState({
          opened: true,
          pedidoIds: rows.map((r) => r.id),
        });
        return;
      }
      try {
        await dispatchEmitirNFe(client, rows);
      } catch (err) {
        if (err instanceof NFeLoteNotImplementedError) {
          // Defensive — the rows.length>1 check above should have
          // caught this. If we got here, the action ran with mixed
          // semantics; surface so the user sees something.
          notifications.show({
            title: 'Emissão em lote',
            message: err.message,
            color: 'yellow',
            autoClose: 8000,
          });
          return;
        }
        throw err;
      }
    },
  };

  const loteModal: EmitirLoteModalState = {
    opened: loteState.opened,
    pedidoIds: loteState.pedidoIds,
    close: () => setLoteState((s) => ({ ...s, opened: false })),
  };

  return { action, loteModal };
}
