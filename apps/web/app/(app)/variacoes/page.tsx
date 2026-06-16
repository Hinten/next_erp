'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { grupoDeVariacoesMeta, grupoDeVariacoesSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function VariacoesPage() {
  return (
    <TableView
      title="Variações"
      description="Grupos de variação (Tamanho, Cor, …) aplicados aos produtos."
      schema={grupoDeVariacoesSchema}
      collection={grupoDeVariacoesCollection}
      db={getFirebaseFirestore()}
      meta={grupoDeVariacoesMeta}
      defaultColumns={['nome', 'codigo', 'ordem', 'permiteFotos']}
      rowHref={(id) => `/variacoes/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/variacoes/novo">
          Novo grupo
        </Button>
      )}
      copyHref="/variacoes/novo"
      selectable
      actions={[
        {
          id: 'delete',
          label: 'Excluir',
          color: 'red',
          requiresSelection: true,
          refreshOnComplete: true,
          confirm: {
            title: 'Excluir grupos de variação',
            message: 'Grupos excluídos não podem ser restaurados. Confirmar exclusão?',
          },
          run: async (rows) => {
            const db = getFirebaseFirestore();
            await Promise.all(
              rows.map((r) => deleteDoc(grupoDeVariacoesCollection.docRef(db, {}, r.id))),
            );
          },
        },
      ]}
    />
  );
}
