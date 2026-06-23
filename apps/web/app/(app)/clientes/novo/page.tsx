'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Anchor, Group, Stack, Title } from '@mantine/core';
import { IconMapPin } from '@tabler/icons-react';
import { clienteFormSchema } from '@delfrance/schemas';
import { nowMillis } from '@delfrance/core/datetime';
import { ObjectView } from '@delfrance/ui';
import { CnpjLookupConfigProvider, CnpjLookupField } from '@/components/inputs/CnpjLookupField';
import { TelefoneField, prepareForSaveTelefone } from '@/components/inputs/TelefoneInput';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import type { ClienteCnpjEndereco } from '@/lib/clientes/consultaCnpj';
import { useDefaultFilialId } from '@/lib/clientes/useDefaultFilialId';
import { stashEnderecoForCliente } from '@/lib/clientes/pendingEndereco';

// Module-level: ObjectView identity-tracks `fields`. The CNPJ "buscar dados"
// affordance (PJ only) gets its filial + address-offer wiring from context.
const CLIENTE_FORM_FIELDS = {
  cpf_cnpj: { renderInput: CnpjLookupField },
  telefone: { renderInput: TelefoneField, prepareForSave: prepareForSaveTelefone },
};

export default function NovoClientePage() {
  const router = useRouter();
  const { user } = useAuth();
  const filialId = useDefaultFilialId();

  // No cliente id yet → the resolved address can't be written to the enderecos
  // subcollection. Hold it and relay to the detail page after the cliente saves.
  const pendingEnderecoRef = useRef<ClienteCnpjEndereco | null>(null);
  const [enderecoFound, setEnderecoFound] = useState(false);

  function handleAddressResolved(endereco: ClienteCnpjEndereco) {
    pendingEnderecoRef.current = endereco;
    setEnderecoFound(true);
  }

  function handleSaved(id: string) {
    if (pendingEnderecoRef.current) stashEnderecoForCliente(id, pendingEnderecoRef.current);
    router.replace(`/clientes/${id}`);
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Novo cliente</Title>
        <Anchor component={Link} href="/clientes" size="sm">
          Cancelar
        </Anchor>
      </Group>

      {enderecoFound && (
        <Alert color="blue" icon={<IconMapPin size={16} />} title="Endereço encontrado">
          O endereço deste CNPJ foi encontrado e será oferecido para cadastro após salvar o cliente.
        </Alert>
      )}

      <CnpjLookupConfigProvider value={{ filialId, onAddressResolved: handleAddressResolved }}>
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
          onSaved={handleSaved}
        />
      </CnpjLookupConfigProvider>
    </Stack>
  );
}
