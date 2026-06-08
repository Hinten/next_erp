'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { depositoSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function DepositosPage() {
  return (
    <TableView
      title="Depósitos de estoque"
      description="Locais físicos que armazenam estoque."
      schema={depositoSchema}
      collection={depositoCollection}
      db={getFirebaseFirestore()}
      defaultColumns={['nome', 'ativo']}
      orderBy={{ field: 'nome', direction: 'asc' }}
      pageSize={50}
      rowHref={(id) => `/depositos/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/depositos/novo">
          Novo depósito
        </Button>
      )}
      copyHref="/depositos/novo"
      selectable
      actions={[
        {
          id: 'delete',
          label: 'Excluir',
          color: 'red',
          requiresSelection: true,
          refreshOnComplete: true,
          confirm: {
            title: 'Excluir depósitos',
            message: 'Depósitos excluídos não podem ser restaurados. Confirmar exclusão?',
          },
          run: async (rows) => {
            const db = getFirebaseFirestore();
            await Promise.all(rows.map((r) => deleteDoc(depositoCollection.docRef(db, {}, r.id))));
          },
        },
      ]}
    />
  );
}
