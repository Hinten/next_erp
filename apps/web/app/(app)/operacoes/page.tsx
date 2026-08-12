'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { TIPO_NFE_LABELS, operacaoMeta, operacaoSchema, type TipoNFe } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function OperacoesPage() {
  const { allowed: canDelete } = usePermission(PERM.fiscal.delete);

  return (
    <TableView
      title="Operações fiscais"
      description="Naturezas de operação (CFOP, regime tributário, configuração de impostos) usadas pelos pedidos."
      schema={operacaoSchema}
      collection={operacaoCollection}
      db={getFirebaseFirestore()}
      meta={operacaoMeta}
      defaultColumns={[
        'nome',
        'tipo',
        'movimentaEstoque',
        'padrao',
        'cfop',
        'cfopInterestadual',
        'timestamp',
      ]}
      fields={{
        tipo: {
          label: 'Tipo',
          renderCell: (v) => TIPO_NFE_LABELS[v as TipoNFe] ?? String(v ?? ''),
        },
        movimentaEstoque: { label: 'Movimenta estoque' },
        padrao: { label: 'Padrão' },
        cfopInterestadual: { label: 'CFOP inter.' },
      }}
      rowHref={(id) => `/operacoes/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/operacoes/novo">
          Nova operação
        </Button>
      )}
      copyHref="/operacoes/novo"
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
                  title: 'Excluir operações',
                  message:
                    'As operações e suas regras de imposto serão excluídas e não poderão ser restauradas. Confirmar?',
                },
                run: async (rows) => {
                  const db = getFirebaseFirestore();
                  await Promise.all(
                    rows.map((r) => deleteDoc(operacaoCollection.docRef(db, {}, r.id))),
                  );
                },
              },
            ]
          : []
      }
    />
  );
}
