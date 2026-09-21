'use client';

import { Suspense, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Anchor, Group, Stack, Title } from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import { IconMapPin, IconUserExclamation } from '@tabler/icons-react';
import { clienteFormSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { CnpjLookupConfigProvider } from '@/components/inputs/CnpjLookupField';
import {
  CLIENTE_FORM_FIELDS,
  deriveClienteTelefonePatch,
  prepareClienteCopy,
} from '@/lib/clientes/formFields';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { PERM } from '@delfrance/auth';
import { useAuth, usePermission } from '@/lib/auth';
import type { ClienteCnpjEndereco } from '@/lib/clientes/consultaCnpj';
import { type DedupCandidate, checkClienteDuplicates } from '@/lib/clientes/dedup';
import { useDefaultFilialId } from '@/lib/clientes/useDefaultFilialId';
import { stashEnderecoForCliente } from '@/lib/clientes/pendingEndereco';

export default function NovoClientePage() {
  // `useSearchParams` (prefill from the chat side panel) requires a Suspense
  // boundary in Next 16.
  return (
    <Suspense fallback={null}>
      <NovoClienteForm />
    </Suspense>
  );
}

function NovoClienteForm() {
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.cliente.write);
  const filialId = useDefaultFilialId();
  // Optional prefill from the chat side panel's "Criar cliente" link:
  // `?userCliente=<documents/usuarios/uid>&nome=<conversa nome>`. `userCliente`
  // stays excluded from the form (below) but rides through `defaultValues` and
  // is persisted on create (saveRecord writes the full form values on create).
  const searchParams = useSearchParams();
  const userClientePrefill = searchParams.get('userCliente');
  const nomePrefill = searchParams.get('nome');

  // No cliente id yet → the resolved address can't be written to the enderecos
  // subcollection. Hold it and relay to the detail page after the cliente saves.
  const pendingEnderecoRef = useRef<ClienteCnpjEndereco | null>(null);
  const [enderecoFound, setEnderecoFound] = useState(false);
  // A cliente already registered under the looked-up CNPJ, if any — offered as a
  // link to its cadastro so the operator can go there instead of duplicating it.
  const [existingCliente, setExistingCliente] = useState<DedupCandidate | null>(null);
  // Monotonic lookup id: only the latest async dedup may update state, so a slow
  // in-flight check can't overwrite a newer lookup or a CNPJ edit with a stale hit.
  const lookupSeq = useRef(0);

  function handleAddressResolved(endereco: ClienteCnpjEndereco | null) {
    // Track the latest lookup result — null retracts a previously found address
    // (no-address lookup or an edited CNPJ) so we never relay a stale one.
    pendingEnderecoRef.current = endereco;
    setEnderecoFound(endereco !== null);
  }

  async function handleCnpjLookedUp(cnpj: string | null) {
    // Bump first — a CNPJ edit (null) also invalidates any in-flight lookup.
    const seq = ++lookupSeq.current;
    if (!cnpj) {
      setExistingCliente(null);
      return;
    }
    try {
      // Only the cpf_cnpj sub-check runs — the empty inputs skip theirs. An exact
      // match lands in `blocking`; surface the first as a link to its cadastro.
      const { blocking } = await checkClienteDuplicates(getFirebaseFirestore(), {
        cpf_cnpj: cnpj,
        idEstrangeiro: '',
        nome: '',
        email: '',
        telefone: '',
      });
      // Drop the result if a newer lookup/edit superseded this one.
      if (seq !== lookupSeq.current) return;
      setExistingCliente(blocking[0] ?? null);
    } catch (err) {
      // Best-effort: a transient read failure just skips the warning.
      if (err instanceof FirebaseError) {
        if (seq === lookupSeq.current) setExistingCliente(null);
        return;
      }
      throw err;
    }
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

      {existingCliente && (
        <Alert
          color="yellow"
          icon={<IconUserExclamation size={16} />}
          title="Cliente já cadastrado"
        >
          Já existe um cliente com este CNPJ:{' '}
          {existingCliente.nome ?? existingCliente.cpf_cnpj ?? 'sem nome'}.{' '}
          <Anchor component={Link} href={`/clientes/${existingCliente.id}`}>
            Abrir cadastro existente
          </Anchor>
        </Alert>
      )}

      {enderecoFound && (
        <Alert color="blue" icon={<IconMapPin size={16} />} title="Endereço encontrado">
          O endereço deste CNPJ foi encontrado e será oferecido para cadastro após salvar o cliente.
        </Alert>
      )}

      <CnpjLookupConfigProvider
        value={{
          filialId,
          onAddressResolved: handleAddressResolved,
          onCnpjLookedUp: (cnpj) => void handleCnpjLookedUp(cnpj),
        }}
      >
        <ObjectView
          schema={clienteFormSchema}
          collection={clienteCollection}
          db={getFirebaseFirestore()}
          currentUserUid={user?.uid ?? ''}
          defaultValues={{
            // `timestamp` / `ultimaModificacao` stamped by saveRecord on create.
            ...(nomePrefill ? { nome: nomePrefill } : {}),
            ...(userClientePrefill ? { userCliente: userClientePrefill } : {}),
          }}
          excludedFields={[
            'timestamp',
            'ultimaModificacao',
            'userCliente',
            'telefoneGerenciado',
            'isUF',
            'idEstrangeiro',
          ]}
          fields={CLIENTE_FORM_FIELDS}
          transformCopiedValues={prepareClienteCopy}
          deriveTransactionPatch={deriveClienteTelefonePatch}
          saveLabel="Criar"
          canEdit={canWrite}
          readOnly={!canWrite}
          showSaveAndContinue={false}
          onSaved={handleSaved}
        />
      </CnpjLookupConfigProvider>
    </Stack>
  );
}
