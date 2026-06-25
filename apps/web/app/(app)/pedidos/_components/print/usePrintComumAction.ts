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
  readonly close: () => void;
}

export function usePrintComumAction(): {
  readonly action: ActionConfig<Pedido>;
  readonly printModal: PrintComumModalState;
} {
  const [state, setState] = useState<{ opened: boolean; pedidoIds: ReadonlyArray<string> }>({
    opened: false,
    pedidoIds: [],
  });

  const action: ActionConfig<Pedido> = {
    id: 'print-comum',
    label: 'Imprimir',
    color: 'blue',
    requiresSelection: true,
    run: (rows) => {
      setState({ opened: true, pedidoIds: rows.map((r) => r.id) });
      return Promise.resolve();
    },
  };

  const printModal: PrintComumModalState = {
    opened: state.opened,
    pedidoIds: state.pedidoIds,
    close: () => setState((s) => ({ ...s, opened: false })),
  };

  return { action, printModal };
}
