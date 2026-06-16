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

/**
 * "Endereços" sub-table rendered on the cliente detail page. Lists the
 * `clientes/{clienteId}/enderecos` subcollection and edits it in place via the
 * shared `EnderecoFormModal` (create / edit / delete) — the same modal the
 * pedido Frete tab opens for inline "create-or-select".
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
        meta={enderecoMeta}
        defaultColumns={['logradouro', 'numero', 'bairro', 'cidade', 'estado', 'cep']}
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
    </Stack>
  );
}
