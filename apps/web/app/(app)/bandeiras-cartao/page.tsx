'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { bandeiraCartaoMeta, bandeiraCartaoSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import { bandeiraCartaoCollection } from '@/lib/data/bandeiraCartaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function BandeirasCartaoPage() {
  const { allowed: canDelete } = usePermission(PERM.pagamento.delete);

  return (
    <TableView
      title="Bandeiras de cartão"
      description="Cadastro das bandeiras de cartão aceitas."
      schema={bandeiraCartaoSchema}
      collection={bandeiraCartaoCollection}
      db={getFirebaseFirestore()}
      meta={bandeiraCartaoMeta}
      defaultColumns={['nome', 'bandeira', 'ehCredito', 'maxParcelas']}
      rowHref={(id) => `/bandeiras-cartao/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/bandeiras-cartao/novo">
          Nova bandeira
        </Button>
      )}
      copyHref="/bandeiras-cartao/novo"
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
                  title: 'Excluir bandeiras de cartão',
                  message: 'Bandeiras excluídas não podem ser restauradas. Confirmar exclusão?',
                },
                run: async (rows) => {
                  const db = getFirebaseFirestore();
                  await Promise.all(
                    rows.map((r) => deleteDoc(bandeiraCartaoCollection.docRef(db, {}, r.id))),
                  );
                },
              },
            ]
          : []
      }
    />
  );
}
