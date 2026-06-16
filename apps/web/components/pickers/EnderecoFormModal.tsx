'use client';

import { useMemo } from 'react';
import { Modal } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { enderecoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
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
 * Schema-driven endereço create/edit modal over the
 * `clientes/{clienteId}/enderecos` subcollection. Shared by the cliente
 * detail page (`EnderecosSection`) and the pedido Frete tab's address picker
 * (`EnderecoPicker` — inline "create-or-select"). Editing/creating an
 * endereço always goes through this one modal so the field set and defaults
 * stay in sync.
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
      {/* Conditional mount so every open starts with a fresh form. */}
      {opened && (
        <ObjectView
          schema={enderecoSchema}
          collection={enderecoCollection}
          db={db}
          pathContext={pathContext}
          currentUserUid={user?.uid ?? ''}
          recordId={recordId}
          defaultValues={{ bairro: 'SEM BAIRRO' }}
          excludedFields={['idExterno']}
          sections={['Endereço', RECEBEDOR_SECTION]}
          fields={ENDERECO_FORM_FIELDS}
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
      )}
    </Modal>
  );
}
