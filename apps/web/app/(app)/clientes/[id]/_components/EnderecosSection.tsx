'use client';

import { useMemo, useState } from 'react';
import { Button, Stack, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { enderecoMeta, enderecoSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { enderecoCollection } from '@/lib/data/enderecoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { usePermission } from '@/lib/auth';
import { EnderecoFormModal } from '@/components/pickers/EnderecoFormModal';
import { RecebedorNfeModal } from '@/components/pickers/RecebedorNfeModal';

/**
 * "Endereços" sub-table on the cliente detail page over the
 * `clientes/{clienteId}/enderecos` subcollection. Address create/edit/delete
 * runs through `EnderecoFormModal`; the NF-e recebedor (destinatário) of each
 * row is edited in the SEPARATE `RecebedorNfeModal`, opened from a per-row
 * button. Both modals are shared with the pedido Frete tab.
 *
 * The Pipelines row source is one-shot, so `refreshNonce` keys the TableView
 * and is bumped after every modal save/delete to remount it with fresh data.
 */
export function EnderecosSection({ clienteId }: { clienteId: string }) {
  const db = getFirebaseFirestore();
  const { allowed: canWrite } = usePermission(PERM.endereco.write);

  // The data layer identity-tracks pathContext — keep the object stable.
  const pathContext = useMemo(() => ({ clienteId }), [clienteId]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [recebedorId, setRecebedorId] = useState<string | null>(null);
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
    setRecebedorId(null);
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
        meta={enderecoMeta}
        defaultColumns={['logradouro', 'numero', 'bairro', 'cidade', 'estado', 'cep', 'recebedor']}
        virtualColumns={[
          {
            key: 'recebedor',
            label: 'Recebedor (NFe)',
            dependsOn: [],
            renderCell: (row) => (
              <Button
                size="xs"
                variant="subtle"
                onClick={(e) => {
                  // Don't let the click bubble into the row's onRowClick (which
                  // opens the address modal).
                  e.stopPropagation();
                  setRecebedorId(row.id);
                }}
              >
                Recebedor
              </Button>
            ),
          },
        ]}
        onRowClick={(id) => openEdit(id)}
        renderNewButton={
          canWrite ? () => <Button onClick={openCreate}>Novo endereço</Button> : undefined
        }
      />

      <EnderecoFormModal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        clienteId={clienteId}
        recordId={editingId}
        onSaved={afterChange}
        allowDelete
        onDeleted={afterChange}
      />

      {recebedorId && (
        <RecebedorNfeModal
          opened={recebedorId !== null}
          onClose={() => setRecebedorId(null)}
          clienteId={clienteId}
          recordId={recebedorId}
          onSaved={afterChange}
        />
      )}
    </Stack>
  );
}
