'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { categoriaMeta, categoriaSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function CategoriasPage() {
  return (
    <TableView
      title="Categorias"
      description="Árvore de categorias do catálogo."
      schema={categoriaSchema}
      collection={categoriaCollection}
      db={getFirebaseFirestore()}
      meta={categoriaMeta}
      defaultColumns={['nome', 'nomeCompleto', 'permiteCadastro']}
      rowHref={(id) => `/categorias/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/categorias/novo">
          Nova categoria
        </Button>
      )}
      copyHref="/categorias/novo"
      selectable
      actions={[
        {
          id: 'delete',
          label: 'Excluir',
          color: 'red',
          requiresSelection: true,
          refreshOnComplete: true,
          confirm: {
            title: 'Excluir categorias',
            message: 'Categorias excluídas não podem ser restauradas. Confirmar exclusão?',
          },
          run: async (rows) => {
            const db = getFirebaseFirestore();
            await Promise.all(rows.map((r) => deleteDoc(categoriaCollection.docRef(db, {}, r.id))));
          },
        },
      ]}
    />
  );
}
