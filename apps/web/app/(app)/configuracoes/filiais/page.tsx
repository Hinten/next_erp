'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { filialMeta, filialSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { formatCNPJ } from '@delfrance/core/documents';
import { usePermission } from '@/lib/auth';
import { filialCollection } from '@/lib/data/filialCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';

export default function FiliaisPage() {
  const router = useRouter();
  // `configuracoes` has no delete bit — `filialMeta.permissions.delete` is
  // PERM_CONFIG_WRITE, and the generated rule agrees (`allow delete: if …
  // p('d_configuracoes', 2)`). Gate on what Firestore actually enforces.
  const { allowed: canDelete } = usePermission(PERM.configuracoes.write);

  return (
    <TableView<typeof filialSchema>
      title="Filiais"
      description="Cadastro das filiais do grupo econômico."
      schema={filialSchema}
      collection={filialCollection}
      db={getFirebaseFirestore()}
      meta={filialMeta}
      defaultColumns={['razaoSocial', 'fantasia', 'cnpj', 'timestamp']}
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
          id: 'inutilizar',
          label: 'Inutilizar numeração',
          requiresSelection: true,
          run: (rows) => {
            // Inutilização is per-filial — navigate to the selected filial's
            // screen (mirrors the old Flutter filiaisTableView action).
            const target = rows[0];
            if (rows.length !== 1 || !target) {
              showErrorNotification({
                title: 'Selecione uma única filial',
                message: 'A inutilização de numeração é feita por filial. Selecione apenas uma.',
              });
              return;
            }
            router.push(`/configuracoes/filiais/${target.id}/inutilizar`);
          },
        },
        // Only the delete is gated — "Inutilizar numeração" is a navigation,
        // not a write, so it stays available to anyone who can read a filial.
        ...(canDelete
          ? [
              {
                id: 'delete',
                label: 'Excluir',
                color: 'red' as const,
                requiresSelection: true,
                confirm: {
                  title: 'Excluir filiais',
                  message: 'Filiais excluídas não podem ser restauradas. Confirmar exclusão?',
                },
                run: async (rows: Array<{ id: string }>) => {
                  const db = getFirebaseFirestore();
                  await Promise.all(
                    rows.map((r) => deleteDoc(filialCollection.docRef(db, {}, r.id))),
                  );
                },
              },
            ]
          : []),
      ]}
    />
  );
}
