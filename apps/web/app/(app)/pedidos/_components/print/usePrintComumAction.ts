'use client';

/**
 * The `/pedidos` TableView "Imprimir" bulk action — opens the
 * {@link PrintComumDialog} with the selected pedido ids. Mirrors the shape of
 * `useEmitirNFeAction` (action + modal state the page binds to the dialog).
 */
import { useState } from 'react';
import type { Pedido } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';

export interface PrintComumModalState {
  readonly opened: boolean;
  readonly pedidoIds: ReadonlyArray<string>;
  /** How many of the selected pedidos were already printed (`foiImpresso`). */
  readonly alreadyPrintedCount: number;
  readonly close: () => void;
}

export function usePrintComumAction(): {
  readonly action: ActionConfig<Pedido>;
  readonly printModal: PrintComumModalState;
} {
  const [state, setState] = useState<{
    opened: boolean;
    pedidoIds: ReadonlyArray<string>;
    alreadyPrintedCount: number;
  }>({ opened: false, pedidoIds: [], alreadyPrintedCount: 0 });

  const action: ActionConfig<Pedido> = {
    id: 'print-comum',
    label: 'Imprimir',
    color: 'blue',
    requiresSelection: true,
    run: (rows) => {
      setState({
        opened: true,
        pedidoIds: rows.map((r) => r.id),
        // The Flutter guard: warn before re-printing already-printed pedidos.
        // The /pedidos TableView projects only the columns' fields, so
        // `foiImpresso` may be absent — `dtImpressao` (the "Imp." column, set
        // together with `foiImpresso` on every print) is the reliable signal.
        alreadyPrintedCount: rows.filter(
          (r) => r.data.foiImpresso === true || r.data.dtImpressao != null,
        ).length,
      });
      return Promise.resolve();
    },
  };

  const printModal: PrintComumModalState = {
    opened: state.opened,
    pedidoIds: state.pedidoIds,
    alreadyPrintedCount: state.alreadyPrintedCount,
    close: () => setState((s) => ({ ...s, opened: false })),
  };

  return { action, printModal };
}
