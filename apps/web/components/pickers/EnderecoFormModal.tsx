'use client';

import { useMemo } from 'react';
import { Modal } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { enderecoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { CepField } from '@/components/inputs/CepInput';
import { ENDERECO_HIDDEN_KEYS } from '@/components/inputs/enderecoFields';
import { enderecoCollection } from '@/lib/data/enderecoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';

/**
 * Recebedor (NFe / destinatário) keys are edited in the SEPARATE
 * `RecebedorNfeModal`, and system/auto fields (`idExterno`, country code, IBGE
 * município) aren't user-entered — both are hidden here. This modal renders the
 * endereço at the TOP level, so it hides via `excludedFields` (a flat array),
 * sharing the key list with the embedded forms.
 */
const ADDRESS_HIDDEN_KEYS = [...ENDERECO_HIDDEN_KEYS];

const ADDRESS_FIELDS = {
  cep: { renderInput: CepField },
};

const ADDRESS_DEFAULTS = {
  bairro: 'SEM BAIRRO',
  // Brazil by default (NFe country code 1058 / xPais BRASIL). Hidden in the
  // form but written on create; legacy docs keep their stored values.
  cPais: '1058',
  pais: 'Brasil',
};

export interface EnderecoFormModalProps {
  opened: boolean;
  onClose: () => void;
  /** Cliente whose `clientes/{clienteId}/enderecos` subcollection is edited. */
  clienteId: string;
  /** undefined ⇒ create mode. */
  recordId?: string;
  /** Called with the saved doc id (new or edited). */
  onSaved: (id: string) => void;
  /** Enable in-modal delete (the cliente detail screen). Default false. */
  allowDelete?: boolean;
  /** Called after a successful delete (only when `allowDelete`). */
  onDeleted?: () => void;
}

/**
 * Schema-driven **endereço (address-only)** create/edit modal over the
 * `clientes/{clienteId}/enderecos` subcollection. The Recebedor (NFe) fields
 * live in the separate `RecebedorNfeModal`. The CEP field carries a "Buscar
 * CEP" (ViaCEP) lookup that autofills logradouro/bairro/cidade/estado/IBGE.
 * Shared by the cliente detail screen (`EnderecosSection`) and the pedido
 * Frete tab's inline "+ Novo endereço".
 */
export function EnderecoFormModal({
  opened,
  onClose,
  clienteId,
  recordId,
  onSaved,
  allowDelete = false,
  onDeleted,
}: EnderecoFormModalProps) {
  const db = getFirebaseFirestore();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.endereco.write);
  const { allowed: canDelete } = usePermission(PERM.endereco.delete);

  // The data layer identity-tracks pathContext — keep the object stable.
  const pathContext = useMemo(() => ({ clienteId }), [clienteId]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={recordId ? 'Editar endereço' : 'Novo endereço'}
      size="lg"
    >
      {/* Conditional mount so every open starts fresh. The `onSubmit` guard
          stops the inner form's submit from bubbling up the React tree (the
          portaled Modal is still a React-tree descendant) into an ancestor
          <form> — e.g. the pedido form when opened from the Frete tab. */}
      {opened && (
        <div onSubmit={(e) => e.stopPropagation()}>
          <ObjectView
            schema={enderecoSchema}
            collection={enderecoCollection}
            db={db}
            pathContext={pathContext}
            currentUserUid={user?.uid ?? ''}
            recordId={recordId}
            defaultValues={ADDRESS_DEFAULTS}
            excludedFields={ADDRESS_HIDDEN_KEYS}
            fields={ADDRESS_FIELDS}
            saveLabel={recordId ? 'Salvar alterações' : 'Criar'}
            showSaveAndContinue={false}
            canEdit={canWrite}
            readOnly={!canWrite}
            canDelete={allowDelete && canDelete}
            onDelete={
              allowDelete
                ? async (id) => {
                    await deleteDoc(enderecoCollection.docRef(db, pathContext, id));
                    onDeleted?.();
                  }
                : undefined
            }
            onSaved={onSaved}
          />
        </div>
      )}
    </Modal>
  );
}
