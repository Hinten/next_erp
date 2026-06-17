'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { clienteFormSchema } from '@delfrance/schemas';
import { nowMillis } from '@delfrance/core/datetime';
import { ObjectView } from '@delfrance/ui';
import { CpfCnpjField } from '@/components/inputs/CpfCnpjInput';
import { TelefoneField, prepareForSaveTelefone } from '@/components/inputs/TelefoneInput';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';

// Module-level: ObjectView identity-tracks `fields`.
const CLIENTE_FORM_FIELDS = {
  cpf_cnpj: { renderInput: CpfCnpjField },
  telefone: { renderInput: TelefoneField, prepareForSave: prepareForSaveTelefone },
};

export default function NovoClientePage() {
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Novo cliente</Title>
        <Anchor component={Link} href="/clientes" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={clienteFormSchema}
        collection={clienteCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{ timestamp: nowMillis() }}
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
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/clientes/${id}`)}
      />
    </Stack>
  );
}
