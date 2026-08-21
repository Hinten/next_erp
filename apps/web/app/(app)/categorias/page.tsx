'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { categoriaMeta, categoriaSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function CategoriasPage() {
  const { allowed: canDelete } = usePermission(PERM.categoria.delete);

  return (
    <TableView
      title="Categorias"
      description="Árvore de categorias do catálogo."
      schema={categoriaSchema}
      collection={categoriaCollection}
      db={getFirebaseFirestore()}
      meta={categoriaMeta}
      rowHref={(id) => `/categorias/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/categorias/novo">
          Nova categoria
        </Button>
      )}
      copyHref="/categorias/novo"
      selectable
      // Hiding, not disabling: `ActionConfig` has no `hidden` flag, so the gate
      // filters the array (same shape as /canais/whatsapp). Firestore already
      // refuses the write — this stops the button promising what the rules
      // reject. `usePermission` reports false while claims resolve, so it
      // appears a beat after mount.
      actions={
        canDelete
          ? [
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
                  await Promise.all(
                    rows.map((r) => deleteDoc(categoriaCollection.docRef(db, {}, r.id))),
                  );
                },
              },
            ]
          : []
      }
    />
  );
}
