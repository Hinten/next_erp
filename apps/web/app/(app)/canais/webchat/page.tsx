'use client';

import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Button } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { webchatMeta, webchatSchema, type Webchat } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import { webchatCollection } from '@/lib/data/webchatCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import {
  GerarScriptWebchatModal,
  useGerarScriptWebchatAction,
} from './_components/GerarScriptWebchatModal';

export default function CanalWebchatPage() {
  const db = getFirebaseFirestore();
  const { allowed: canDelete } = usePermission(PERM.webchat.delete);
  const { action: gerarScriptAction, opened, docId, nome, close } = useGerarScriptWebchatAction();

  return (
    <>
      <TableView<typeof webchatSchema>
        title="Webchat"
        description="Configuração do widget de webchat embarcável."
        schema={webchatSchema}
        collection={webchatCollection}
        db={db}
        meta={webchatMeta}
        rowHref={(id) => `/canais/webchat/${id}`}
        renderNewButton={() => (
          <Button component={Link} href="/canais/webchat/novo">
            Novo webchat
          </Button>
        )}
        selectable
        actions={[
          gerarScriptAction,
          ...(canDelete
            ? [
                {
                  id: 'delete',
                  label: 'Excluir',
                  color: 'red',
                  requiresSelection: true,
                  refreshOnComplete: true,
                  confirm: {
                    title: 'Excluir configurações de webchat',
                    message:
                      'Configurações excluídas não podem ser restauradas. Confirmar exclusão?',
                  },
                  run: async (rows: { id: string; data: Webchat }[]) => {
                    await Promise.all(
                      rows.map((r) => deleteDoc(webchatCollection.docRef(db, {}, r.id))),
                    );
                  },
                },
              ]
            : []),
        ]}
      />
      <GerarScriptWebchatModal opened={opened} docId={docId} nome={nome} onClose={close} />
    </>
  );
}
