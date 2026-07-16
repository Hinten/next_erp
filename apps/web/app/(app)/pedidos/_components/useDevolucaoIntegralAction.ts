'use client';

/**
 * "Devolução integral" row action for the saída `/pedidos` list (#551): with
 * exactly one returnable saída selected, jump to the pre-seeded entrada create
 * page (`/pedidos/entradas/novo?devolucaoDe=<id>`), which clones the origin
 * into a full return. Wired via `PedidosListView`'s `extraActions` seam on the
 * saída page only.
 */
import { useRouter } from 'next/navigation';
import type { Pedido } from '@delfrance/schemas';
import type { ActionConfig } from '@delfrance/ui';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { createClientPedidoPort } from '@/lib/pedidos/clientPort';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';
import { isReturnableOrigin } from './tabs/devolucaoForm';

export function useDevolucaoIntegralAction(): ActionConfig<Pedido> {
  const router = useRouter();
  return {
    id: 'devolucao-integral',
    label: 'Devolução integral',
    requiresSelection: true,
    run: async (rows) => {
      if (rows.length !== 1) {
        showErrorNotification({
          title: 'Devolução integral',
          message: 'Selecione exatamente um pedido.',
        });
        return;
      }
      const row = rows[0]!;
      // Never trust the Pipeline-projected `row.data`: hiding a column strips
      // its `dependsOn` fields (`ehSaida`/`estado`), which would falsely reject
      // every row — eligibility runs on a fresh read of the full doc.
      const pedido = await createClientPedidoPort(getFirebaseFirestore()).getPedido(row.id);
      if (pedido === null || !isReturnableOrigin(pedido as Pedido, row.id, new Set())) {
        showErrorNotification({
          title: 'Devolução integral',
          message: 'Apenas pedidos de saída com estado elegível podem gerar devolução integral.',
        });
        return;
      }
      router.push(`/pedidos/entradas/novo?devolucaoDe=${row.id}`);
    },
  };
}
