'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Stack, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { type Endereco, enderecoMeta, enderecoSchema } from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { enderecoCollection } from '@/lib/data/enderecoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { usePermission } from '@/lib/auth';
import { EnderecoFormModal } from '@/components/pickers/EnderecoFormModal';
import { RecebedorNfeModal } from '@/components/pickers/RecebedorNfeModal';
import type { ClienteCnpjEndereco } from '@/lib/clientes/consultaCnpj';

/** The CNPJ-lookup address maps 1:1 onto enderecoSchema keys (estado is a UF). */
function toEnderecoPrefill(e: ClienteCnpjEndereco): Partial<Endereco> {
  return { ...e, estado: e.estado as Endereco['estado'] };
}

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
export interface EnderecosSectionProps {
  clienteId: string;
  /**
   * Address resolved by a CNPJ lookup (or relayed from the create page). When it
   * becomes non-null the create modal opens prefilled; `onPrefillConsumed` fires
   * once the modal is saved or dismissed so the parent can clear it.
   */
  prefillEndereco?: ClienteCnpjEndereco | null;
  onPrefillConsumed?: () => void;
}

export function EnderecosSection({
  clienteId,
  prefillEndereco,
  onPrefillConsumed,
}: EnderecosSectionProps) {
  const db = getFirebaseFirestore();
  const { allowed: canWrite } = usePermission(PERM.endereco.write);

  // The data layer identity-tracks pathContext — keep the object stable.
  const pathContext = useMemo(() => ({ clienteId }), [clienteId]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [recebedorId, setRecebedorId] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // A resolved CNPJ address opens the create modal prefilled for review — but
  // only when the user can write endereços. Without the permission, consume the
  // prefill instead of popping a read-only (confusing) "offer".
  useEffect(() => {
    if (!prefillEndereco) return;
    if (!canWrite) {
      onPrefillConsumed?.();
      return;
    }
    setEditingId(undefined);
    setModalOpen(true);
  }, [prefillEndereco, canWrite, onPrefillConsumed]);

  function openCreate() {
    setEditingId(undefined);
    setModalOpen(true);
  }

  function openEdit(id: string) {
    setEditingId(id);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    onPrefillConsumed?.();
  }

  function afterChange() {
    setModalOpen(false);
    setRecebedorId(null);
    setRefreshNonce((n) => n + 1);
    onPrefillConsumed?.();
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
        onClose={closeModal}
        clienteId={clienteId}
        recordId={editingId}
        prefill={!editingId && prefillEndereco ? toEnderecoPrefill(prefillEndereco) : undefined}
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
