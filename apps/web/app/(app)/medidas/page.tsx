'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { tabelaDeMedidasMeta, tabelaDeMedidasSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function MedidasPage() {
  return (
    <TableView
      title="Tabelas de medidas"
      description="Tabelas de medidas (moda) usadas para normalizar tamanhos nos marketplaces."
      schema={tabelaDeMedidasSchema}
      collection={tabelaDeMedidasCollection}
      db={getFirebaseFirestore()}
      meta={tabelaDeMedidasMeta}
      defaultColumns={['nome', 'codigo', 'descricao']}
      rowHref={(id) => `/medidas/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/medidas/novo">
          Nova tabela de medidas
        </Button>
      )}
      copyHref="/medidas/novo"
      selectable
      actions={[
        {
          id: 'delete',
          label: 'Excluir',
          color: 'red',
          requiresSelection: true,
          refreshOnComplete: true,
          confirm: {
            title: 'Excluir tabelas de medidas',
            message: 'Tabelas de medidas excluídas não podem ser restauradas. Confirmar exclusão?',
          },
          run: async (rows) => {
            const db = getFirebaseFirestore();
            await Promise.all(
              rows.map((r) => deleteDoc(tabelaDeMedidasCollection.docRef(db, {}, r.id))),
            );
          },
        },
      ]}
    />
  );
}
