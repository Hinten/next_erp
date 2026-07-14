'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { listaDePrecosSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import {
  LISTA_DE_PRECOS_CREATE_DEFAULTS,
  LISTA_DE_PRECOS_EXCLUDED_FIELDS,
  LISTA_DE_PRECOS_SECTIONS,
  listaDePrecosFields,
} from '../_components/listaDePrecosFields';

export default function NovaListaDePrecosPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.produto.write);
  const db = getFirebaseFirestore();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova lista de preços</Title>
        <Anchor component={Link} href="/listas-de-precos" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={listaDePrecosSchema}
        collection={listaDePrecosCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        defaultValues={LISTA_DE_PRECOS_CREATE_DEFAULTS}
        excludedFields={LISTA_DE_PRECOS_EXCLUDED_FIELDS}
        fields={listaDePrecosFields}
        sections={LISTA_DE_PRECOS_SECTIONS}
        saveLabel="Criar"
        showSaveAndContinue={false}
        canEdit={canWrite}
        readOnly={!canWrite}
        onSaved={(id) => router.replace(`/listas-de-precos/${id}/editar`)}
      />
    </Stack>
  );
}
