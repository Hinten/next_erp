'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, TextInput, Title } from '@mantine/core';
import { clienteSchema } from '@delfrance/schemas';
import { ObjectView, type FieldRenderProps } from '@delfrance/ui';
import { formatCNPJ, formatCPF } from '@delfrance/core/documents';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';

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

export default function EditarClientePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Editar cliente</Title>
        <Anchor component={Link} href={`/clientes/${params.id}`} size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={clienteSchema}
        collection={clienteCollection}
        db={getFirebaseFirestore()}
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
        onSaved={(id) => router.replace(`/clientes/${id}`)}
      />
    </Stack>
  );
}
