'use client';

import { notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import { lixeiraSchema } from '@delfrance/schemas';
import {
  RestoreConflictError,
  TrashEntryNotFoundError,
  purgeTrashEntry,
  restoreFromTrash,
} from '@delfrance/data';
import { TableView } from '@delfrance/ui';
import { lixeiraCollection } from '@/lib/data/lixeiraCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function LixeiraPage() {
  return (
    <TableView
      title="Itens excluídos"
      description="Documentos removidos são guardados aqui e podem ser restaurados à coleção de origem ou descartados definitivamente."
      schema={lixeiraSchema}
      collection={lixeiraCollection}
      db={getFirebaseFirestore()}
      defaultColumns={['label', 'collectionPath', 'deletedAt', 'deletedBy']}
      orderBy={{ field: 'deletedAt', direction: 'desc' }}
      pageSize={50}
      selectable
      actions={[
        {
          id: 'restore',
          label: 'Restaurar',
          requiresSelection: true,
          run: async (rows) => {
            const db = getFirebaseFirestore();
            const failed: string[] = [];
            let restored = 0;
            for (const r of rows) {
              try {
                await restoreFromTrash({ db, trashId: r.id });
                restored += 1;
              } catch (err) {
                if (
                  err instanceof RestoreConflictError ||
                  err instanceof TrashEntryNotFoundError ||
                  err instanceof FirebaseError
                ) {
                  failed.push(r.data.label ?? r.id);
                  continue;
                }
                throw err;
              }
            }
            if (restored > 0) {
              notifications.show({
                color: 'green',
                message: `${restored} item(ns) restaurado(s).`,
              });
            }
            if (failed.length > 0) {
              notifications.show({
                color: 'red',
                message: `Falha ao restaurar: ${failed.join(', ')}.`,
              });
            }
          },
        },
        {
          id: 'purge',
          label: 'Excluir definitivamente',
          color: 'red',
          requiresSelection: true,
          confirm: {
            title: 'Excluir definitivamente',
            message:
              'Os itens selecionados serão removidos da lixeira e não poderão mais ser recuperados. Confirmar?',
          },
          run: async (rows) => {
            const db = getFirebaseFirestore();
            await Promise.all(
              rows.map((r) => purgeTrashEntry({ db, trashId: r.id })),
            );
            notifications.show({
              color: 'green',
              message: `${rows.length} item(ns) removido(s) definitivamente.`,
            });
          },
        },
      ]}
    />
  );
}
