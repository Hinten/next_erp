'use client';

import { useMemo, useState } from 'react';
import { Button, Modal, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { enderecoSchema } from '@delfrance/schemas';
import { ObjectView, TableView } from '@delfrance/ui';
import { enderecoCollection } from '@/lib/data/enderecoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';

const RECEBEDOR_SECTION = 'Recebedor (NFe)';

// The NFe-recebedor fields go into a second tab; every other field falls
// through to the first section ('Endereço').
const ENDERECO_FORM_FIELDS = {
  nome: { section: RECEBEDOR_SECTION },
  cpf_cnpj: { section: RECEBEDOR_SECTION },
  rg: { section: RECEBEDOR_SECTION },
  ie: { section: RECEBEDOR_SECTION },
  imun: { section: RECEBEDOR_SECTION },
  email: { section: RECEBEDOR_SECTION },
  telefone: { section: RECEBEDOR_SECTION },
};

/**
 * "Endereços" sub-table rendered on the cliente detail page. Lists the
 * `clientes/{clienteId}/enderecos` subcollection and edits it in place via a
 * modal-hosted `ObjectView` (create / edit / delete).
 *
 * The Pipelines row source is one-shot, so `refreshNonce` keys the TableView
 * and is bumped after every modal save/delete to remount it with fresh data.
 */
export function EnderecosSection({ clienteId }: { clienteId: string }) {
  const db = getFirebaseFirestore();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.endereco.write);
  const { allowed: canDelete } = usePermission(PERM.endereco.delete);

  // The data layer identity-tracks pathContext — keep the object stable.
  const pathContext = useMemo(() => ({ clienteId }), [clienteId]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [refreshNonce, setRefreshNonce] = useState(0);

  function openCreate() {
    setEditingId(undefined);
    setModalOpen(true);
  }

  function openEdit(id: string) {
    setEditingId(id);
    setModalOpen(true);
  }

  function afterChange() {
    setModalOpen(false);
    setRefreshNonce((n) => n + 1);
  }

  return (
    <Stack>
      <Title order={3}>Endereços</Title>

      <TableView<typeof enderecoSchema>
        key={refreshNonce}
        schema={enderecoSchema}
        collection={enderecoCollection}
        db={db}
        pathContext={pathContext}
        defaultColumns={[
          'logradouro',
          'numero',
          'bairro',
          'cidade',
          'estado',
          'cep',
        ]}
        orderBy={{ field: 'logradouro', direction: 'asc' }}
        onRowClick={(id) => openEdit(id)}
        renderNewButton={
          canWrite
            ? () => <Button onClick={openCreate}>Novo endereço</Button>
            : undefined
        }
      />

      <Modal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? 'Editar endereço' : 'Novo endereço'}
        size="lg"
      >
        {modalOpen && (
          <ObjectView
            schema={enderecoSchema}
            collection={enderecoCollection}
            db={db}
            pathContext={pathContext}
            currentUserUid={user?.uid ?? ''}
            recordId={editingId}
            defaultValues={{ bairro: 'SEM BAIRRO' }}
            excludedFields={['idExterno']}
            sections={['Endereço', RECEBEDOR_SECTION]}
            fields={ENDERECO_FORM_FIELDS}
            saveLabel={editingId ? 'Salvar alterações' : 'Criar'}
            showSaveAndContinue={false}
            canEdit={canWrite}
            readOnly={!canWrite}
            canDelete={canDelete}
            onDelete={async (id) => {
              await deleteDoc(enderecoCollection.docRef(db, pathContext, id));
              afterChange();
            }}
            onSaved={afterChange}
          />
        )}
      </Modal>
    </Stack>
  );
}
