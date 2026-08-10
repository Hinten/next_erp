'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { type FieldConfig, ObjectView } from '@delfrance/ui';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { MacrosTab } from '../_components/MacrosTab';
import {
  OPERACAO_EXCLUDED_FIELDS,
  OPERACAO_SECTIONS,
  OPERACAO_TRANSIENT_FIELDS,
  operacaoPageSchema,
  operacaoStaticFields,
} from '../_components/operacaoFields';

export default function OperacaoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.fiscal.write);
  const db = getFirebaseFirestore();

  const fields = useMemo<Record<string, FieldConfig>>(
    () => ({
      ...operacaoStaticFields,
      macros: {
        section: 'Regras de imposto',
        label: 'Regras de imposto',
        renderInput: (p) => <MacrosTab operacaoId={params.id} disabled={p.disabled} />,
      },
    }),
    [params.id],
  );

  // The `onOperacaoDeleted` Cloud Function trigger is the authoritative
  // cascade — it sweeps `regras` server-side (#354). This only deletes the
  // parent doc.
  async function handleDelete(id: string) {
    await deleteDoc(operacaoCollection.docRef(db, {}, id));
    router.replace('/operacoes');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Operação fiscal</Title>
        <Anchor component={Link} href="/operacoes" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={operacaoPageSchema}
        collection={operacaoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        sections={[...OPERACAO_SECTIONS]}
        fields={fields}
        excludedFields={OPERACAO_EXCLUDED_FIELDS}
        transientFields={OPERACAO_TRANSIENT_FIELDS}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        deleteConfirmMessage="A operação e suas regras de imposto serão excluídas permanentemente."
        onSaved={() => router.replace('/operacoes')}
      />
    </Stack>
  );
}
