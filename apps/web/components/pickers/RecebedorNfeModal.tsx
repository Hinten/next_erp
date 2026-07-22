'use client';

import { useMemo } from 'react';
import { Modal, Text } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { enderecoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { enderecoCollection } from '@/lib/data/enderecoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';

/**
 * Address keys — edited in the SEPARATE `EnderecoFormModal`. This modal shows
 * only the Recebedor (NFe / destinatário) fields. The hidden address fields
 * are still loaded into the form from the existing doc, so they validate and
 * the partial save only touches the recebedor fields.
 */
const ADDRESS_KEYS = [
  'idExterno',
  'logradouro',
  'numero',
  'bairro',
  'complemento',
  'cep',
  'codigoMunicipio',
  'cidade',
  'estado',
  'cPais',
  'pais',
  // System stamps — not recebedor inputs.
  'timestamp',
  'ultimaModificacao',
];

export interface RecebedorNfeModalProps {
  opened: boolean;
  onClose: () => void;
  clienteId: string;
  /** The existing endereço whose recebedor data is edited (required — the
   *  recebedor presupposes an address). */
  recordId: string;
  onSaved: (id: string) => void;
}

/**
 * Schema-driven **Recebedor (NFe)** editor — the destinatário fields of an
 * existing endereço (`clientes/{clienteId}/enderecos/{recordId}`), kept in a
 * modal separate from the address fields (`EnderecoFormModal`).
 */
export function RecebedorNfeModal({
  opened,
  onClose,
  clienteId,
  recordId,
  onSaved,
}: RecebedorNfeModalProps) {
  const db = getFirebaseFirestore();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.endereco.write);

  const pathContext = useMemo(() => ({ clienteId }), [clienteId]);

  return (
    <Modal opened={opened} onClose={onClose} title="Recebedor (NFe)" size="lg">
      {opened && (
        <div onSubmit={(e) => e.stopPropagation()}>
          <Text size="xs" c="dimmed" mb="sm">
            Dados do destinatário usados na NF-e. Opcionais — preencha apenas se o recebedor for
            diferente do cliente.
          </Text>
          <ObjectView
            schema={enderecoSchema}
            collection={enderecoCollection}
            db={db}
            pathContext={pathContext}
            currentUserUid={user?.uid ?? ''}
            recordId={recordId}
            excludedFields={ADDRESS_KEYS}
            saveLabel="Salvar alterações"
            showSaveAndContinue={false}
            canEdit={canWrite}
            readOnly={!canWrite}
            onSaved={onSaved}
          />
        </div>
      )}
    </Modal>
  );
}
