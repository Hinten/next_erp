'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { grupoDeVariacoesSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import {
  GRUPO_EXCLUDED_FIELDS,
  GRUPO_SECTIONS,
  deriveVariacoesIds,
  grupoFields,
} from '../_components/grupoFields';

export default function NovoGrupoVariacaoPage() {
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Novo grupo de variação</Title>
        <Anchor component={Link} href="/variacoes" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={grupoDeVariacoesSchema}
        collection={grupoDeVariacoesCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{
          ordem: 1,
          permiteFotos: false,
          variacoes: [],
        }}
        sections={GRUPO_SECTIONS}
        fields={grupoFields}
        excludedFields={GRUPO_EXCLUDED_FIELDS}
        deriveOnSave={deriveVariacoesIds}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/variacoes/${id}`)}
      />
    </Stack>
  );
}
