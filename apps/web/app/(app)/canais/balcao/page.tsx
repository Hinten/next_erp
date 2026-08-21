'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Badge, Button } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import {
  INTEGRACAO_TIPO,
  type Integracao,
  integracaoMeta,
  integracaoSchema,
} from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function CanalBalcaoPage() {
  const db = getFirebaseFirestore();
  const { allowed: canDelete } = usePermission(PERM.integracao.delete);

  // The `integracao` collection holds every channel type; the Balcão screen is
  // one slice. integracaoMeta.defaultQuery declares the `tipo` param + `nome`
  // ordering (and its Firestore index); `queryParams` binds the slice. Column
  // filters keep working on top of the base `tipo` filter.
  return (
    <TableView<typeof integracaoSchema>
      title="Balcão"
      description="Canais de venda de balcão (sem integração com marketplace)."
      schema={integracaoSchema}
      collection={integracaoCollection}
      db={db}
      meta={integracaoMeta}
      queryParams={{ tipo: INTEGRACAO_TIPO.balcao }}
      rowHref={(id) => `/canais/balcao/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/canais/balcao/novo">
          Novo balcão
        </Button>
      )}
      fields={{
        ativo: {
          renderCell: (value) =>
            value ? (
              <Badge color="green" variant="light">
                Ativo
              </Badge>
            ) : (
              <Badge color="gray" variant="light">
                Inativo
              </Badge>
            ),
        },
        padrao: {
          renderCell: (value) =>
            value ? (
              <Badge color="blue" variant="outline">
                Padrão
              </Badge>
            ) : (
              '—'
            ),
        },
      }}
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
                  title: 'Excluir canais de balcão',
                  message: 'Canais excluídos não podem ser restaurados. Confirmar exclusão?',
                },
                run: async (rows) => {
                  await Promise.all(
                    rows.map((r: { id: string; data: Integracao }) =>
                      deleteDoc(integracaoCollection.docRef(db, {}, r.id)),
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
