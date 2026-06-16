'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { clienteSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { CpfCnpjField } from '@/components/inputs/CpfCnpjInput';
import { TelefoneField, prepareForSaveTelefone } from '@/components/inputs/TelefoneInput';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { EnderecosSection } from './_components/EnderecosSection';

// Module-level: ObjectView identity-tracks `fields`.
const CLIENTE_FORM_FIELDS = {
  cpf_cnpj: { renderInput: CpfCnpjField },
  telefone: { renderInput: TelefoneField, prepareForSave: prepareForSaveTelefone },
};

export default function ClientePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.cliente.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(clienteCollection.docRef(db, {}, id));
    router.replace('/clientes');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Cliente</Title>
        <Anchor component={Link} href="/clientes" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={clienteSchema}
        collection={clienteCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        excludedFields={[
          'timestamp',
          'ultimaModificacao',
          'nome_embedding',
          'telefone_embedding',
          'userCliente',
          'isUF',
          'idEstrangeiro',
        ]}
        fields={CLIENTE_FORM_FIELDS}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        onSaved={() => router.replace('/clientes')}
      />

      <EnderecosSection clienteId={params.id} />
    </Stack>
  );
}
