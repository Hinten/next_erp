'use client';

import { Suspense } from 'react';
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
import { ShopeeCallbackToast } from './_components/ShopeeCallbackToast';

/**
 * `/canais/shopee` — the Shopee accounts list.
 *
 * This screen replaced the static `CanalCapsPanel` placeholder the moment the
 * channel gained a real backend (`apps/shopee`, master-plan step 1). The panel
 * component itself stays: it is what the four channels with no backend yet
 * (Amazon, Facebook, Loja Integrada, Magalu) still render.
 */
export default function CanalShopeePage() {
  const db = getFirebaseFirestore();
  // The delete is PERM.integracao.delete-gated by the Firestore rules;
  // `ActionConfig` has no `hidden` flag, so gating means filtering the array
  // (same shape as /canais/whatsapp and /canais/mercado-livre). `usePermission`
  // reports `false` while claims resolve, so the button appears a beat after
  // mount.
  const { allowed: canDelete } = usePermission(PERM.integracao.delete);

  // The `integracao` collection holds every channel type; the Shopee screen is
  // one slice. `integracaoMeta.defaultQuery` declares the `tipo` param + `nome`
  // ordering (and its Firestore index); `queryParams` binds the slice.
  return (
    <>
      {/* The OAuth callback redirects HERE for the two failures that happen
          before a trustworthy integração id exists (config / bad_state).
          Behind Suspense because the hook reads useSearchParams — without a
          boundary the production build refuses to prerender this route. */}
      <Suspense fallback={null}>
        <ShopeeCallbackToast />
      </Suspense>

      {/*
        Step 1 of the integration ships the connection and nothing else, and an
        operator has no way to tell a channel that is merely quiet from one that
        is not wired up yet. Saying it here is cheaper than the support ticket
        that starts with "the Shopee orders never arrived".
      */}
      <Alert color="blue" title="O que esta tela faz hoje" mb="md">
        Esta tela cadastra a conta e faz a conexão OAuth com a Shopee — e só isso. Importar
        anúncios, importar pedidos, enviar estoque, enviar preço, emitir etiqueta e enviar NF-e
        ainda não estão ligados neste canal; cada um chega em um passo seguinte da integração. Até
        lá nada é sincronizado automaticamente com a Shopee, em nenhuma direção.
      </Alert>

      <TableView<typeof integracaoSchema>
        title="Shopee"
        description="Contas conectadas da integração com a Shopee."
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={db}
        meta={integracaoMeta}
        queryParams={{ tipo: INTEGRACAO_TIPO.shopee }}
        // Overrides `integracaoMeta.defaultQuery.columns`: the same meta backs
        // /canais/balcao and /canais/mercado-livre, which show data de cadastro
        // instead. `shop_id` is the column that answers "which Shopee shop is
        // this?" — the one question the list cannot answer from `nome` alone.
        defaultColumns={['nome', 'shop_id', 'ativo', 'padrao']}
        rowHref={(id) => `/canais/shopee/${id}`}
        renderNewButton={() => (
          <Button component={Link} href="/canais/shopee/novo">
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
          shop_id: { label: 'Shop ID' },
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
                    title: 'Excluir conta Shopee',
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
