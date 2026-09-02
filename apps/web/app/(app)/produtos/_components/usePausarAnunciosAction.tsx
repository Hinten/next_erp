'use client';

import { useState } from 'react';
import { notifications } from '@mantine/notifications';
import type { ActionConfig } from '@delfrance/ui';
import type { Produto } from '@delfrance/schemas';
import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import type { PausarAnuncioAlvo } from '@/lib/marketplace/anuncioStatus/pausarAnunciosRun';

/**
 * The produtos-table bulk action: pause the selected produtos' anúncios on every
 * marketplace they are listed on.
 *
 * ⚠️ **Pause only — reactivate is deliberately not offered in bulk.** The route
 * takes both directions and the machinery is symmetric, so this is a product
 * decision rather than a limitation: putting listings back on air is the
 * direction where the operator most needs to see WHICH anúncio they are acting
 * on, and that view is the produto's Mercado Livre tab. A bulk reactivate is one
 * `acao` away if it is ever wanted.
 *
 * A pure "open the dialog" action, the `useEnviarEstoqueAction` shape:
 * `ActionConfig.confirm` can only show a fixed title/message, and this flow
 * needs the run's own progress report.
 */

/** The same ceiling the other two produto-scoped pushes use; the route rejects past it. */
export const MAX_SELECAO_PAUSAR_ANUNCIOS = 50;

export interface PausarAnunciosModalState {
  opened: boolean;
  alvos: PausarAnuncioAlvo[];
  close: () => void;
}

export function usePausarAnunciosAction(): {
  action: ActionConfig<Produto>;
  modal: PausarAnunciosModalState;
} {
  const [state, setState] = useState<{ opened: boolean; alvos: PausarAnuncioAlvo[] }>({
    opened: false,
    alvos: [],
  });

  const action: ActionConfig<Produto> = {
    id: 'pausar-anuncios',
    label: 'Pausar anúncios',
    requiresSelection: true,
    run: async (rows) => {
      if (rows.length === 0) {
        notifications.show({ color: 'gray', message: 'Selecione 1 produto para pausar o anúncio' });
        return;
      }
      if (rows.length > MAX_SELECAO_PAUSAR_ANUNCIOS) {
        // Tell the operator BEFORE the round-trip; the route rejects the same
        // way, and rejecting beats truncating — a silently dropped tail under a
        // green summary is the failure this whole area guards against.
        notifications.show({
          color: 'yellow',
          message: `Selecione no máximo ${String(MAX_SELECAO_PAUSAR_ANUNCIOS)} produtos para pausar os anúncios.`,
        });
        return;
      }

      // Re-read the selected produtos rather than trusting `row.data`: TableView
      // projects only the VISIBLE columns' fields, and `integracoesComProduto`
      // is not one of them, so it would arrive `undefined`. `getDocsByIds`
      // chunks `in` at the SDK's 30-id cap, so the 50-produto ceiling costs 2
      // queries.
      const frescos = await getDocsByIds(
        getFirebaseFirestore(),
        produtoCollection,
        rows.map((r) => r.id),
      );
      const alvos: PausarAnuncioAlvo[] = rows.map((r) => {
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
