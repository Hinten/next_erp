'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { deleteDoc, orderBy, query, where } from 'firebase/firestore';
import { Badge, Button } from '@mantine/core';
import {
  INTEGRACAO_TIPO,
  type Integracao,
  integracaoSchema,
} from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function CanalBalcaoPage() {
  const db = getFirebaseFirestore();

  // The `integracao` collection holds every channel type; the Balcão screen
  // is just one slice (`tipo == 7`). `queryOverride` is the documented escape
  // hatch — when set, the TableView's own orderBy/pageSize AND its column-
  // filter pipeline are bypassed (the caller owns the query lifecycle), so
  // both the `where` and the `orderBy` ship together here. The column-filter
  // popovers still render but won't narrow the result set; until TableView
  // grows a `baseFilters` prop, restricting the channel by `tipo` and giving
  // up user-driven column filters on this screen is the trade-off.
  const balcaoQuery = useMemo(
    () =>
      query(
        integracaoCollection.ref(db, {}),
        where('tipo', '==', INTEGRACAO_TIPO.balcao),
        orderBy('nome', 'asc'),
      ),
    [db],
  );

  return (
    <TableView<typeof integracaoSchema>
      title="Balcão"
      description="Canais de venda de balcão (sem integração com marketplace)."
      schema={integracaoSchema}
      collection={integracaoCollection}
      db={db}
      queryOverride={balcaoQuery}
      defaultColumns={['nome', 'ativo', 'padrao', 'dataCadastro']}
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
      actions={[
        {
          id: 'delete',
          label: 'Excluir',
          color: 'red',
          requiresSelection: true,
          refreshOnComplete: true,
          confirm: {
            title: 'Excluir canais de balcão',
            message:
              'Canais excluídos não podem ser restaurados. Confirmar exclusão?',
          },
          run: async (rows) => {
            await Promise.all(
              rows.map((r: { id: string; data: Integracao }) =>
                deleteDoc(integracaoCollection.docRef(db, {}, r.id)),
              ),
            );
          },
        },
      ]}
    />
  );
}
