'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, TextInput, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { clienteSchema } from '@delfrance/schemas';
import { ObjectView, type FieldRenderProps } from '@delfrance/ui';
import { formatCNPJ, formatCPF } from '@delfrance/core/documents';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';

function CpfCnpjInput({
  value,
  onChange,
  onBlur,
  error,
  label,
  hint,
}: FieldRenderProps) {
  const v = (value as string | null | undefined) ?? '';
  const formatted =
    v.length === 11 ? formatCPF(v) : v.length === 14 ? formatCNPJ(v) : null;
  return (
    <TextInput
      label={label}
      description={formatted ?? hint ?? 'Apenas números'}
      value={v}
      onChange={(e) => onChange(e.currentTarget.value)}
      onBlur={onBlur}
      error={error}
      maxLength={14}
      inputMode="numeric"
    />
  );
}

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
          'nome_embedding',
          'telefone_embedding',
          'userCliente',
          'isUF',
          'idEstrangeiro',
        ]}
        fields={{ cpf_cnpj: { renderInput: CpfCnpjInput } }}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        onSaved={() => router.replace('/clientes')}
      />
    </Stack>
  );
}
