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
 * `/canais/loja-integrada`: the Loja Integrada contas list.
 *
 * This screen replaced the static `CanalCapsPanel` placeholder once the channel
 * gained a registered conta (master-plan step 2). The panel component itself
 * stays: it is what the channels with no screen yet (Amazon, Facebook, Magalu)
 * still render.
 */
export default function CanalLojaIntegradaPage() {
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
        Registering a conta is all this screen does today, and an operator has no
        way to tell a channel that is merely quiet from one that is not wired up
        yet. Saying it here is cheaper than the support ticket that starts with
        "the Loja Integrada orders never arrived".
      */}
      <Alert color="blue" title="O que esta tela faz hoje" mb="md">
        Esta tela cadastra a conta da Loja Integrada, e só isso. Importar produtos, importar
        pedidos, enviar estoque, enviar preço e enviar NF-e ainda não estão ligados neste canal;
        cada um chega em um passo seguinte da integração. Até lá nada é sincronizado automaticamente
        com a Loja Integrada, em nenhuma direção.
      </Alert>

      <TableView<typeof integracaoSchema>
        title="Loja Integrada"
        description="Contas da integração com a Loja Integrada."
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={db}
        meta={integracaoMeta}
        queryParams={{ tipo: INTEGRACAO_TIPO.lojaIntegrada }}
        // Overrides `integracaoMeta.defaultQuery.columns`: the same meta backs
        // every channel list, and this conta has no channel-specific column.
        defaultColumns={['nome', 'ativo', 'padrao']}
        rowHref={(id) => `/canais/loja-integrada/${id}`}
        rowLinkColumn="nome"
        renderNewButton={() => (
          <Button component={Link} href="/canais/loja-integrada/novo">
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
                    title: 'Excluir conta Loja Integrada',
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
