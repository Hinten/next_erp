'use client';

import Link from 'next/link';
import { deleteDoc, getDocs } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { TIPO_NFE_LABELS, operacaoMeta, operacaoSchema, type TipoNFe } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { regraImpostoCollection } from '@/lib/data/regraImpostoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/** Delete an operação and its `regraimposto` subcollection (avoid orphans). */
async function deleteOperacaoCascade(id: string) {
  const db = getFirebaseFirestore();
  const regras = await getDocs(regraImpostoCollection.ref(db, { operacaoId: id }));
  await Promise.all(regras.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(operacaoCollection.docRef(db, {}, id));
}

export default function OperacoesPage() {
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
      actions={[
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
            await Promise.all(rows.map((r) => deleteOperacaoCascade(r.id)));
          },
        },
      ]}
    />
  );
}
