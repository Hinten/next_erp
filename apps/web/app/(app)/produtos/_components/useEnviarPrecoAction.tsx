'use client';

import { useState } from 'react';
import { notifications } from '@mantine/notifications';
import type { ActionConfig } from '@delfrance/ui';
import type { Produto } from '@delfrance/schemas';
import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import type { EnviarPrecoAlvo } from '@/lib/marketplace/preco/enviarPrecoRun';

/**
 * The produtos-table bulk action — the port of the legacy `EnviarPrecoAction`
 * (`.old/lib/produtos/pages/produtoTableView.dart:397-434`).
 *
 * A pure "open the dialog" action, the `useEnviarEstoqueAction` shape:
 * `ActionConfig.confirm` can only show a fixed title/message, and this flow
 * needs the "Permitir baixar preços" checkbox before it runs.
 */

/** Legacy parity (`produtoTableView.dart:417`) — and the backend rejects past it. */
export const MAX_SELECAO_ENVIO_PRECO = 50;

export interface EnviarPrecoModalState {
  opened: boolean;
  alvos: EnviarPrecoAlvo[];
  close: () => void;
}

export function useEnviarPrecoAction(): {
  action: ActionConfig<Produto>;
  modal: EnviarPrecoModalState;
} {
  const [state, setState] = useState<{ opened: boolean; alvos: EnviarPrecoAlvo[] }>({
    opened: false,
    alvos: [],
  });

  const action: ActionConfig<Produto> = {
    id: 'enviar-preco',
    label: 'Enviar preços',
    requiresSelection: true,
    run: async (rows) => {
      if (rows.length === 0) {
        notifications.show({ color: 'gray', message: 'Selecione 1 produto para enviar o preço' });
        return;
      }
      if (rows.length > MAX_SELECAO_ENVIO_PRECO) {
        // Tell the operator BEFORE the round-trip; the route rejects the same
        // way, and rejecting beats truncating (a silently dropped tail under a
        // green summary is the failure this whole area guards against).
        notifications.show({
          color: 'yellow',
          message:
            `Selecione no máximo ${String(MAX_SELECAO_ENVIO_PRECO)} produtos para enviar o ` +
            'preço. Use "Atualizar preços" na tela do canal para a conta inteira.',
        });
        return;
      }

      // Re-read the selected produtos rather than trusting `row.data`:
      // TableView projects only the VISIBLE columns' fields, and
      // `integracoesComProduto` is not one of them, so it would arrive
      // `undefined`. `getDocsByIds` chunks `in` at the SDK's 30-id cap and runs
      // the chunks concurrently, so the 50-produto ceiling costs 2 queries.
      const frescos = await getDocsByIds(
        getFirebaseFirestore(),
        produtoCollection,
        rows.map((r) => r.id),
      );
      const alvos: EnviarPrecoAlvo[] = rows.map((r) => {
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
