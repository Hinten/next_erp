'use client';

import { pedidoSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';

import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useEmitirNFeAction } from '@/lib/nfe/bulkEmit';

export default function PedidosPage() {
  const emitNFeAction = useEmitirNFeAction();
  return (
    <TableView
      title="Pedidos"
      description="Lista de pedidos. Selecione pedidos e use o botão acima da tabela para emitir NF-e."
      schema={pedidoSchema}
      collection={pedidoCollection}
      db={getFirebaseFirestore()}
      defaultColumns={['numero', 'estado', 'ehSaida']}
      orderBy={{ field: 'numero', direction: 'desc' }}
      pageSize={50}
      rowHref={(id) => `/pedidos/${id}`}
      selectable
      actions={[emitNFeAction]}
    />
  );
}
