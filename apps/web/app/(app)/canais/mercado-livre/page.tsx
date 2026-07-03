'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Badge, Button } from '@mantine/core';
import {
  INTEGRACAO_TIPO,
  type Integracao,
  integracaoMeta,
  integracaoSchema,
} from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function CanalMercadoLivrePage() {
  const db = getFirebaseFirestore();

  // The `integracao` collection holds every channel type; the Mercado Livre
  // screen is one slice. integracaoMeta.defaultQuery declares the `tipo` param
  // + `nome` ordering; `queryParams` binds the slice. Mirrors /canais/balcao.
  return (
    <TableView<typeof integracaoSchema>
      title="Mercado Livre"
      description="Contas conectadas da integração com o Mercado Livre."
      schema={integracaoSchema}
      collection={integracaoCollection}
      db={db}
      meta={integracaoMeta}
      queryParams={{ tipo: INTEGRACAO_TIPO.mercadoLivre }}
      defaultColumns={['nome', 'ativo', 'padrao', 'dataCadastro']}
      rowHref={(id) => `/canais/mercado-livre/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/canais/mercado-livre/novo">
          Nova conta
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
            title: 'Excluir contas Mercado Livre',
            message:
              'Excluir a conta remove a configuração e a credencial do canal. Confirmar exclusão?',
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
