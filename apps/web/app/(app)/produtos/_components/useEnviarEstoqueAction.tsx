'use client';

import { useState } from 'react';
import { notifications } from '@mantine/notifications';
import type { ActionConfig } from '@delfrance/ui';
import type { Produto } from '@delfrance/schemas';
import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import type { EnviarEstoqueAlvo } from '@/lib/marketplace/estoque/enviarEstoqueRun';

/**
 * The produtos-table bulk action — the port of the legacy `EnviarEstoqueAction`
 * (`.old/lib/produtos/pages/produtoTableView.dart:1139-1175`).
 *
 * A pure "open the dialog" action, the `usePrintComumAction` shape:
 * `ActionConfig.confirm` can only show a fixed title/message, and this flow
 * needs the "Reenviar anúncios com erro" checkbox before it runs.
 */

/** Legacy parity (`produtoTableView.dart:1153`) — and the backend rejects past it. */
export const MAX_SELECAO_ENVIO_ESTOQUE = 50;

export interface EnviarEstoqueModalState {
  opened: boolean;
  alvos: EnviarEstoqueAlvo[];
  close: () => void;
}

export function useEnviarEstoqueAction(): {
  action: ActionConfig<Produto>;
  modal: EnviarEstoqueModalState;
} {
  const [state, setState] = useState<{ opened: boolean; alvos: EnviarEstoqueAlvo[] }>({
    opened: false,
    alvos: [],
  });

  const action: ActionConfig<Produto> = {
    id: 'enviar-estoque',
    label: 'Enviar estoque',
    requiresSelection: true,
    run: async (rows) => {
      if (rows.length === 0) {
        notifications.show({ color: 'gray', message: 'Selecione 1 produto para enviar o estoque' });
        return;
      }
      if (rows.length > MAX_SELECAO_ENVIO_ESTOQUE) {
        // Tell the operator BEFORE the round-trip; the route rejects the same
        // way, and rejecting beats truncating (a silently dropped tail under a
        // green summary is the failure this whole area guards against).
        notifications.show({
          color: 'yellow',
          message:
            `Selecione no máximo ${String(MAX_SELECAO_ENVIO_ESTOQUE)} produtos para enviar o ` +
            'estoque. O envio periódico cobre o restante do catálogo.',
        });
        return;
      }

      // Re-read the selected produtos rather than trusting `row.data`:
      // TableView projects only the VISIBLE columns' fields, and
      // `integracoesComProduto` is not one of them, so it would arrive
      // `undefined`. One chunked `in` query covers 50 ids.
      const frescos = await getDocsByIds(
        getFirebaseFirestore(),
        produtoCollection,
        rows.map((r) => r.id),
      );
      const alvos: EnviarEstoqueAlvo[] = rows.map((r) => {
        const fresco = frescos.get(r.id);
        return {
          produtoId: r.id,
          produtoNome: fresco?.nome ?? r.data.nome,
          integracoesComProduto: fresco?.integracoesComProduto ?? [],
        };
      });
      setState({ opened: true, alvos });
    },
  };

  return {
    action,
    modal: {
      opened: state.opened,
      alvos: state.alvos,
      close: () => setState({ opened: false, alvos: [] }),
    },
  };
}
