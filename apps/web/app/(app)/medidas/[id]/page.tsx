'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { tabelaDeMedidasSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';

export default function TabelaDeMedidasPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.produto.write);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(tabelaDeMedidasCollection.docRef(db, {}, id));
    router.replace('/medidas');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Tabela de medidas</Title>
        <Anchor component={Link} href="/medidas" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={tabelaDeMedidasSchema}
        collection={tabelaDeMedidasCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        // Marketplace maps stay out of the form; the partial-save patch never
        // touches them, so integration-authored ML/Shopee charts are preserved.
        excludedFields={[
          'fotos',
          'fotosArquivosIds',
          'tabelasDeMedidasMercadoLivre',
          'tabelasMedidasShopee',
          'dataCadastro',
          'ultimaModificacao',
        ]}
        fields={{
          descricao: {
            hint: 'Se suportado pelo marketplace, é enviada junto à descrição do produto.',
          },
        }}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        onSaved={() => router.replace('/medidas')}
      />
    </Stack>
  );
}
