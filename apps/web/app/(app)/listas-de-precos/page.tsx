'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Badge, Button } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { type ListaDePrecos, listaDePrecosMeta, listaDePrecosSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { usePermission } from '@/lib/auth';

/** Green/gray badge for a boolean cell (padrão / ativo). */
function boolBadge(value: unknown, on: string, off: string) {
  return value ? (
    <Badge color="green" variant="light">
      {on}
    </Badge>
  ) : (
    <Badge color="gray" variant="light">
      {off}
    </Badge>
  );
}

export default function ListasDePrecosPage() {
  const db = getFirebaseFirestore();
  const { allowed: canWrite } = usePermission(PERM.produto.write);
  const { allowed: canDelete } = usePermission(PERM.produto.delete);

  return (
    <TableView<typeof listaDePrecosSchema>
      title="Listas de preços"
      description="Listas de preços aplicáveis a canais e clientes."
      schema={listaDePrecosSchema}
      collection={listaDePrecosCollection}
      db={db}
      meta={listaDePrecosMeta}
      defaultColumns={['nome', 'padrao', 'ativo']}
      orderBy={{ field: 'nome', direction: 'asc' }}
      rowHref={(id) => `/listas-de-precos/${id}`}
      renderNewButton={
        canWrite
          ? () => (
              <Button component={Link} href="/listas-de-precos/novo">
                Nova lista de preços
              </Button>
            )
          : undefined
      }
      copyHref={canWrite ? '/listas-de-precos/novo' : undefined}
      fields={{
        padrao: { renderCell: (value) => boolBadge(value, 'Padrão', 'Não') },
        ativo: { renderCell: (value) => boolBadge(value, 'Ativo', 'Inativo') },
      }}
      selectable
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
                  title: 'Excluir listas de preços',
                  message:
                    'Listas de preços excluídas não podem ser restauradas. Confirmar exclusão?',
                },
                run: async (rows) => {
                  await Promise.all(
                    rows.map((r: { id: string; data: ListaDePrecos }) =>
                      deleteDoc(listaDePrecosCollection.docRef(db, {}, r.id)),
                    ),
                  );
                },
              },
            ]
          : []
      }
    />
  );
}
