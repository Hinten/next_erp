'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { motivoIncidenteMeta, motivoIncidenteSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import { motivoIncidenteCollection } from '@/lib/data/motivoIncidenteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function MotivosIncidentePage() {
  const { allowed: canDelete } = usePermission(PERM.pedido.delete);

  return (
    <TableView
      title="Motivos de incidente"
      description="Cadastro dos motivos de incidente usados em pedidos."
      schema={motivoIncidenteSchema}
      collection={motivoIncidenteCollection}
      db={getFirebaseFirestore()}
      meta={motivoIncidenteMeta}
      rowHref={(id) => `/motivos-incidente/${id}`}
      renderNewButton={() => (
        <Button component={Link} href="/motivos-incidente/novo">
          Novo motivo
        </Button>
      )}
      copyHref="/motivos-incidente/novo"
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
                  title: 'Excluir motivos de incidente',
                  message: 'Motivos excluídos não podem ser restaurados. Confirmar exclusão?',
                },
                run: async (rows) => {
                  const db = getFirebaseFirestore();
                  await Promise.all(
                    rows.map((r) => deleteDoc(motivoIncidenteCollection.docRef(db, {}, r.id))),
                  );
                },
              },
            ]
          : []
      }
    />
  );
}
