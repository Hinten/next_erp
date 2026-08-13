'use client';

import { Suspense, useState } from 'react';
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
import { MassImportDialog } from './_components/MassImportDialog';
import { MercadoLivreCallbackToast } from './_components/MercadoLivreCallbackToast';
import { MercadoLivreJobsPanel } from './_components/MercadoLivreJobsPanel';
import { PriceSyncDialog } from './_components/PriceSyncDialog';
import { type ContaRef, contaRefFromRow } from './_components/startJobsForContas';
import { useMassImportAction } from './_components/useMassImportAction';
import { usePriceSyncAction } from './_components/usePriceSyncAction';

export default function CanalMercadoLivrePage() {
  const db = getFirebaseFirestore();
  // The bulk jobs are PERM.integracao.write-gated on the backend and the
  // delete is PERM.integracao.delete-gated by the Firestore rules; ActionConfig
  // has no `hidden` flag, so gating means filtering the array (same shape as
  // /canais/whatsapp). `usePermission` reports `false` while claims resolve,
  // so the buttons appear a beat after mount.
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const { allowed: canDelete } = usePermission(PERM.integracao.delete);
  const massImport = useMassImportAction();
  const priceSync = usePriceSyncAction();
  const [selecionadas, setSelecionadas] = useState<readonly ContaRef[]>([]);

  // The `integracao` collection holds every channel type; the Mercado Livre
  // screen is one slice. integracaoMeta.defaultQuery declares the `tipo` param
  // + `nome` ordering; `queryParams` binds the slice. Mirrors /canais/balcao.
  return (
    <>
      {/* The OAuth callback redirects HERE for the failures that happen before a
          trustworthy integração id exists (config / missing_params / bad_state).
          Behind Suspense because the hook reads useSearchParams. */}
      <Suspense fallback={null}>
        <MercadoLivreCallbackToast />
      </Suspense>

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
        onSelectionChange={(rows) => setSelecionadas(rows.map(contaRefFromRow))}
        // The two bulk jobs run for MINUTES and their progress has to stay on
        // screen while the operator keeps working the table — which the top
        // ActionBar structurally cannot host. The rail can, so the actions
        // live there with their progress underneath (#816); 300px is what the
        // job cards need to stay legible.
        actionsPanel={{ width: 300 }}
        renderActionsPanelExtra={({ collapsed }) => (
          <MercadoLivreJobsPanel
            collapsed={collapsed}
            selecionadas={selecionadas}
            massImport={massImport.state}
            priceSync={priceSync.state}
          />
        )}
        actions={[
          ...(canWrite ? [massImport.action, priceSync.action] : []),
          ...(canDelete
            ? [
                {
                  id: 'delete',
                  label: 'Excluir',
                  color: 'red' as const,
                  requiresSelection: true,
                  // One conta at a time, like the two job actions above:
                  // deleting a conta drops its channel credential, and a
                  // multi-row confirm names none of the accounts it is about
                  // to take down.
                  maxSelection: 1,
                  refreshOnComplete: true,
                  confirm: {
                    title: 'Excluir conta Mercado Livre',
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
          stay mounted unconditionally: the action opens them. */}
      <MassImportDialog state={massImport.state} />
      <PriceSyncDialog state={priceSync.state} />
    </>
  );
}
