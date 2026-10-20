'use client';

import { Suspense, useState } from 'react';
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
import { type ContaRef, contaRefFromRow } from '@/lib/marketplace/contaJobs/types';
import { AtualizarPrecosShopeeDialog } from './_components/AtualizarPrecosShopeeDialog';
import { ImportarTodosShopeeDialog } from './_components/ImportarTodosShopeeDialog';
import { ShopeeCallbackToast } from './_components/ShopeeCallbackToast';
import { ShopeeJobsPanel } from './_components/ShopeeJobsPanel';
import { useAtualizarPrecosShopeeAction } from './_components/useAtualizarPrecosShopeeAction';
import { useImportarTodosShopeeAction } from './_components/useImportarTodosShopeeAction';

/**
 * `/canais/shopee` — the Shopee accounts list, and the two account-wide jobs
 * (#1529, step 21-5): "Importar todos os anúncios" and "Atualizar preços",
 * started for the selected conta from the action rail, with their progress
 * cards under the buttons (`_components/ShopeeJobsPanel.tsx`). Mercado Livre's
 * page is the reference shape.
 *
 * This screen replaced the static `CanalCapsPanel` placeholder the moment the
 * channel gained a real backend (`apps/shopee`, master-plan step 1). The panel
 * component itself stays: every channel with no backend yet still renders it —
 * its own docblock keeps the current list, so it is not repeated here.
 */
export default function CanalShopeePage() {
  const db = getFirebaseFirestore();
  // Both jobs — and the three price-job reads the rail makes (status, Histórico,
  // relatório) — are PERM.integracao.write-gated on the backend; the delete is
  // PERM.integracao.delete-gated by the Firestore rules. `ActionConfig` has no
  // `hidden` flag, so gating means filtering the array (same shape as
  // /canais/mercado-livre). `usePermission` reports `false` while claims
  // resolve, so the buttons appear a beat after mount.
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const { allowed: canDelete } = usePermission(PERM.integracao.delete);
  const importacao = useImportarTodosShopeeAction();
  const precos = useAtualizarPrecosShopeeAction();
  const [selecionadas, setSelecionadas] = useState<readonly ContaRef[]>([]);

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
        What THIS screen does, as code — never a claim about what is deployed,
        which rots the day the deployment changes. A job the backend cannot start
        (its queue unreachable, say) still gets a card carrying the backend's own
        sentence, so the operator learns why from the screen instead of from a
        button that seems to do nothing.
      */}
      <Alert color="blue" title="O que esta tela faz" mb="md">
        Esta tela cadastra a conta, faz a conexão OAuth com a Shopee e, para a conta selecionada,
        inicia duas tarefas longas: importar todos os anúncios e atualizar os preços. O andamento de
        cada uma aparece no painel ao lado da lista; uma tarefa que o servidor não conseguir iniciar
        mostra ali o motivo.
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
        rowLinkColumn="nome"
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
        onSelectionChange={(rows) => setSelecionadas(rows.map(contaRefFromRow))}
        // The two jobs run for MINUTES and their progress has to stay on screen
        // while the operator keeps working the table — the rail can host it, the
        // top ActionBar cannot (#816). 300px keeps the job cards legible.
        actionsPanel={{ width: 300 }}
        // ⚠️ The whole jobs panel — cards, Histórico, "Acompanhar" — only for
        // `canWrite`: every price-job read is a `.write` route, so a read-only
        // viewer would get a rail of 403s, for jobs they cannot start anyway.
        renderActionsPanelExtra={
          canWrite
            ? ({ collapsed }) => (
                <ShopeeJobsPanel
                  collapsed={collapsed}
                  selecionadas={selecionadas}
                  importacao={importacao.state}
                  precos={precos.state}
                />
              )
            : undefined
        }
        actions={[
          ...(canWrite ? [importacao.action, precos.action] : []),
          ...(canDelete
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
            : []),
        ]}
      />

      {/* Portalled — their position in the tree is irrelevant, but they must
          stay mounted unconditionally: the actions open them. */}
      <ImportarTodosShopeeDialog state={importacao.state} />
      <AtualizarPrecosShopeeDialog state={precos.state} />
    </>
  );
}
