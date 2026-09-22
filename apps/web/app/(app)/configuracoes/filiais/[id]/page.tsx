'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { filialFormSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { filialCollection } from '@/lib/data/filialCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { filialObjectFields } from '../_components/filialFields';
import { FilialTabs } from '../_components/FilialTabs';

export default function FilialPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.configuracoes.write);
  const db = getFirebaseFirestore();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Filial</Title>
        <Anchor component={Link} href="/configuracoes/filiais" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <FilialTabs filialId={params.id}>
        <ObjectView
          schema={filialFormSchema}
          collection={filialCollection}
          db={db}
          currentUserUid={user?.uid ?? ''}
          recordId={params.id}
          excludedFields={['timestamp', 'ultimaModificacao', 'certificado']}
          fields={filialObjectFields}
          saveLabel="Salvar alterações"
          canEdit={canWrite}
          readOnly={!canWrite}
          onSaved={() => router.replace('/configuracoes/filiais')}
        />
      </FilialTabs>
    </Stack>
  );
}
