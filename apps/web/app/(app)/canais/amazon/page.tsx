'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Alert, Badge, Button } from '@mantine/core';
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

/**
 * `/canais/amazon`: the Amazon contas list (master plan step 21-conta).
 *
 * This screen replaced the static `CanalCapsPanel` placeholder; the panel
 * component itself stays for the channels with no screen yet (its own docblock
 * keeps that list).
 */
export default function CanalAmazonPage() {
  const db = getFirebaseFirestore();
  // The delete is PERM.integracao.delete-gated by the Firestore rules;
  // `ActionConfig` has no `hidden` flag, so gating means filtering the array
  // (same shape as /canais/shopee). `usePermission` reports `false` while claims
  // resolve, so the button appears a beat after mount.
  const { allowed: canDelete } = usePermission(PERM.integracao.delete);

  // The `integracao` collection holds every channel type; this screen is one
  // slice. `integracaoMeta.defaultQuery` declares the `tipo` param + `nome`
  // ordering (and its Firestore index); `queryParams` binds the slice.
  return (
    <>
      {/*
        Registering a conta is all this screen does today, and an operator has
        no way to tell a channel that is merely quiet from one that is not wired
        up yet. Saying it here is cheaper than the support ticket that starts
        with "the Amazon orders never arrived".
      */}
      <Alert color="blue" title="O que esta tela faz hoje" mb="md">
        Esta tela cadastra a conta da Amazon, e só isso. A conexão com a Amazon (a autorização do
        vendedor) é feita na virada do sistema; até lá nada é sincronizado automaticamente com a
        Amazon, em nenhuma direção. Importar pedidos, enviar estoque, enviar preço e enviar NF-e
        chegam em passos seguintes da integração.
      </Alert>

      <TableView<typeof integracaoSchema>
        title="Amazon"
        description="Contas da integração com a Amazon."
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={db}
        meta={integracaoMeta}
        queryParams={{ tipo: INTEGRACAO_TIPO.amazon }}
        // Overrides `integracaoMeta.defaultQuery.columns`: the same meta backs
        // every channel list, and this list shows no channel-specific column.
        defaultColumns={['nome', 'ativo', 'padrao']}
        rowHref={(id) => `/canais/amazon/${id}`}
        rowLinkColumn="nome"
        renderNewButton={() => (
          <Button component={Link} href="/canais/amazon/novo">
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
        actions={
          canDelete
            ? [
                {
                  id: 'delete',
                  label: 'Excluir',
                  color: 'red' as const,
                  requiresSelection: true,
                  // One conta at a time: deleting a conta drops its channel
                  // credential, and a multi-row confirm names none of the
                  // accounts it is about to take down.
                  maxSelection: 1,
                  refreshOnComplete: true,
                  confirm: {
                    title: 'Excluir conta Amazon',
                    message:
                      'Excluir a conta remove a configuração e a credencial do canal. Confirmar exclusão?',
                  },
                  run: async (rows: Array<{ id: string; data: Integracao }>) => {
                    await Promise.all(
                      rows.map((r) => deleteDoc(integracaoCollection.docRef(db, {}, r.id))),
                    );
                  },
                },
              ]
            : []
        }
      />
    </>
  );
}
