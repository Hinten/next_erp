'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Badge, Button } from '@mantine/core';
import {
  type Cliente,
  type TipoCliente,
  TIPO_CLIENTE_LABELS,
  clienteSchema,
} from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function ClientesPage() {
  return (
    <TableView<typeof clienteSchema>
      title="Clientes"
      schema={clienteSchema}
      collection={clienteCollection}
      db={getFirebaseFirestore()}
      defaultColumns={['nome', 'tipo', 'cpf_cnpj', 'email']}
      orderBy={{ field: 'nome', direction: 'asc' }}
      pageSize={50}
      rowHref={(id) => `/clientes/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/clientes/novo">
          Novo cliente
        </Button>
      )}
      copyHref="/clientes/novo"
      fields={{
        tipo: {
          renderCell: (value) =>
            value ? (
              <Badge variant="light">
                {TIPO_CLIENTE_LABELS[value as TipoCliente] ?? String(value)}
              </Badge>
            ) : (
              '—'
            ),
        },
      }}
      selectable
      actions={[
        {
          id: 'delete',
          label: 'Excluir',
          color: 'red',
          requiresSelection: true,
          refreshOnComplete: true,
          confirm: {
            title: 'Excluir clientes',
            message:
              'Clientes excluídos não podem ser restaurados. Confirmar exclusão?',
          },
          run: async (rows) => {
            const db = getFirebaseFirestore();
            await Promise.all(
              rows.map((r: { id: string; data: Cliente }) =>
                deleteDoc(clienteCollection.docRef(db, {}, r.id)),
              ),
            );
          },
        },
      ]}
    />
  );
}
