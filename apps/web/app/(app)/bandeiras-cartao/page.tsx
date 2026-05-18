'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { bandeiraCartaoSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { bandeiraCartaoCollection } from '@/lib/data/bandeiraCartaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function BandeirasCartaoPage() {
  return (
    <TableView
      title="Bandeiras de cartão"
      description="Cadastro das bandeiras de cartão aceitas."
      schema={bandeiraCartaoSchema}
      collection={bandeiraCartaoCollection}
      db={getFirebaseFirestore()}
      defaultColumns={['nome', 'bandeira', 'ehCredito', 'maxParcelas']}
      orderBy={{ field: 'nome', direction: 'asc' }}
      pageSize={50}
      rowHref={(id) => `/bandeiras-cartao/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/bandeiras-cartao/novo">
          Nova bandeira
        </Button>
      )}
      copyHref="/bandeiras-cartao/novo"
      selectable
      actions={[
        {
          id: 'delete',
          label: 'Excluir',
          color: 'red',
          requiresSelection: true,
          confirm: {
            title: 'Excluir bandeiras de cartão',
            message:
              'Bandeiras excluídas não podem ser restauradas. Confirmar exclusão?',
          },
          run: async (rows) => {
            const db = getFirebaseFirestore();
            await Promise.all(
              rows.map((r) =>
                deleteDoc(bandeiraCartaoCollection.docRef(db, {}, r.id)),
              ),
            );
          },
        },
      ]}
    />
  );
}
