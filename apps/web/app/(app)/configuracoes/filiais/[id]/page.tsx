'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Alert, Anchor, Group, Stack, Tabs, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { filialSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { filialCollection } from '@/lib/data/filialCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { filialObjectFields } from '../_components/filialFields';

export default function FilialPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.configuracoes.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(filialCollection.docRef(db, {}, id));
    router.replace('/configuracoes/filiais');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Filial</Title>
        <Anchor component={Link} href="/configuracoes/filiais" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <Tabs defaultValue="dados" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="dados">Dados</Tabs.Tab>
          <Tabs.Tab value="nfe">Configurações NFe</Tabs.Tab>
          <Tabs.Tab value="certificado">Certificado Digital</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="dados" pt="md">
          <ObjectView
            schema={filialSchema}
            collection={filialCollection}
            db={db}
            currentUserUid={user?.uid ?? ''}
            recordId={params.id}
            excludedFields={['timestamp']}
            fields={filialObjectFields}
            saveLabel="Salvar alterações"
            canEdit={canWrite}
            readOnly={!canWrite}
            canDelete={canWrite}
            onDelete={handleDelete}
            onSaved={() => router.replace('/configuracoes/filiais')}
          />
        </Tabs.Panel>

        <Tabs.Panel value="nfe" pt="md">
          <Alert color="blue" title="Em breve">
            A configuração de numeração e ambiente da NF-e desta filial será
            disponibilizada na fase de NF-e.
          </Alert>
        </Tabs.Panel>

        <Tabs.Panel value="certificado" pt="md">
          <Alert color="blue" title="Em breve">
            O envio do certificado digital A1 (.pfx/.pem) desta filial será
            disponibilizado na fase de NF-e.
          </Alert>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
