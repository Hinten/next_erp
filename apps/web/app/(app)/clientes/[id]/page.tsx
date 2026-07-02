'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { clienteFormSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { CnpjLookupConfigProvider, CnpjLookupField } from '@/components/inputs/CnpjLookupField';
import { TelefoneField, prepareForSaveTelefone } from '@/components/inputs/TelefoneInput';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import type { ClienteCnpjEndereco } from '@/lib/clientes/consultaCnpj';
import { useDefaultFilialId } from '@/lib/clientes/useDefaultFilialId';
import { popEnderecoForCliente } from '@/lib/clientes/pendingEndereco';
import { EnderecosSection } from './_components/EnderecosSection';

// Module-level: ObjectView identity-tracks `fields`. The CNPJ "buscar dados"
// affordance (PJ only) gets its filial + address-offer wiring from context.
const CLIENTE_FORM_FIELDS = {
  cpf_cnpj: { renderInput: CnpjLookupField },
  telefone: { renderInput: TelefoneField, prepareForSave: prepareForSaveTelefone },
};

export default function ClientePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.cliente.write);
  const db = getFirebaseFirestore();
  const filialId = useDefaultFilialId();

  const [pendingEndereco, setPendingEndereco] = useState<ClienteCnpjEndereco | null>(null);
  // Stable so EnderecosSection's async prefill effect (which runs a Firestore
  // dedup read) keys only off the address value, not a fresh closure per render.
  const clearPendingEndereco = useCallback(() => setPendingEndereco(null), []);

  // Pick up an address relayed from the CNPJ lookup before this cliente existed
  // (the create page, or the quick-create modal's new-tab link). Reading the
  // one-shot localStorage relay on mount is exactly the "sync from an external
  // system" case effects exist for; StrictMode's setup/cleanup/setup pops twice
  // but the first value sticks (state persists across the re-run).
  useEffect(() => {
    const relayed = popEnderecoForCliente(params.id);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot external read
    if (relayed) setPendingEndereco(relayed);
  }, [params.id]);

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

      <CnpjLookupConfigProvider value={{ filialId, onAddressResolved: setPendingEndereco }}>
        <ObjectView
          schema={clienteFormSchema}
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
      </CnpjLookupConfigProvider>

      <EnderecosSection
        clienteId={params.id}
        prefillEndereco={pendingEndereco}
        onPrefillConsumed={clearPendingEndereco}
      />
    </Stack>
  );
}
