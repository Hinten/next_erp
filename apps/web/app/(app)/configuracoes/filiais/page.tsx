'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { filialSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { formatCNPJ } from '@delfrance/core/documents';
import { filialCollection } from '@/lib/data/filialCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function FiliaisPage() {
  return (
    <TableView<typeof filialSchema>
      title="Filiais"
      description="Cadastro das filiais do grupo econômico."
      schema={filialSchema}
      collection={filialCollection}
      db={getFirebaseFirestore()}
      defaultColumns={['razaoSocial', 'fantasia', 'cnpj', 'timestamp']}
      orderBy={{ field: 'razaoSocial', direction: 'asc' }}
      pageSize={50}
      rowHref={(id) => `/configuracoes/filiais/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/configuracoes/filiais/novo">
          Nova filial
        </Button>
      )}
      fields={{
        // `sede` is an embedded object — not a meaningful table column.
        sede: { hidden: true },
        cnpj: {
          renderCell: (value) => (value ? formatCNPJ(String(value)) : '—'),
        },
        timestamp: { label: 'Data de cadastro' },
      }}
      selectable
      actions={[
        {
          id: 'delete',
          label: 'Excluir',
          color: 'red',
          requiresSelection: true,
          confirm: {
            title: 'Excluir filiais',
            message:
              'Filiais excluídas não podem ser restauradas. Confirmar exclusão?',
          },
          run: async (rows) => {
            const db = getFirebaseFirestore();
            await Promise.all(
              rows.map((r) => deleteDoc(filialCollection.docRef(db, {}, r.id))),
            );
          },
        },
      ]}
    />
  );
}
