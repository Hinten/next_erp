'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { motivoIncidenteSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { motivoIncidenteCollection } from '@/lib/data/motivoIncidenteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function MotivosIncidentePage() {
  return (
    <TableView
      title="Motivos de incidente"
      description="Cadastro dos motivos de incidente usados em pedidos."
      schema={motivoIncidenteSchema}
      collection={motivoIncidenteCollection}
      db={getFirebaseFirestore()}
      defaultColumns={['nome', 'ativo']}
      orderBy={{ field: 'nome', direction: 'asc' }}
      pageSize={50}
      rowHref={(id) => `/motivos-incidente/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/motivos-incidente/novo">
          Novo motivo
        </Button>
      )}
      selectable
      actions={[
        {
          id: 'delete',
          label: 'Excluir',
          color: 'red',
          requiresSelection: true,
          confirm: {
            title: 'Excluir motivos de incidente',
            message:
              'Motivos excluídos não podem ser restaurados. Confirmar exclusão?',
          },
          run: async (rows) => {
            const db = getFirebaseFirestore();
            await Promise.all(
              rows.map((r) =>
                deleteDoc(motivoIncidenteCollection.docRef(db, {}, r.id)),
              ),
            );
          },
        },
      ]}
    />
  );
}
