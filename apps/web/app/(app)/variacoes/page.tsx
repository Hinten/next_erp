'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { grupoDeVariacoesMeta, grupoDeVariacoesSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function VariacoesPage() {
  const { allowed: canDelete } = usePermission(PERM.produto.delete);

  return (
    <TableView
      title="Variações"
      description="Grupos de variação (Tamanho, Cor, …) aplicados aos produtos."
      schema={grupoDeVariacoesSchema}
      collection={grupoDeVariacoesCollection}
      db={getFirebaseFirestore()}
      meta={grupoDeVariacoesMeta}
      rowHref={(id) => `/variacoes/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/variacoes/novo">
          Novo grupo
        </Button>
      )}
      copyHref="/variacoes/novo"
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
            ]
          : []
      }
    />
  );
}
