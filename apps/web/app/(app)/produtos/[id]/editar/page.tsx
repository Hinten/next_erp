'use client';

import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { setDoc } from 'firebase/firestore';
import {
  Alert,
  Anchor,
  Button,
  Group,
  Skeleton,
  Stack,
} from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import { useDocSnapshot } from '@delfrance/data/hooks';
import type { Produto } from '@delfrance/schemas';
import { ProdutoForm } from '../../_components/ProdutoForm';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function EditarProdutoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const docRef = useMemo(
    () => produtoCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  async function handleSubmit(values: Produto) {
    await setDoc(docRef, values, { merge: true });
    router.replace(`/produtos/${params.id}`);
  }

  return (
    <Stack>
      <PageHeader
        title="Editar produto"
        actions={
          <Anchor component={Link} href={`/produtos/${params.id}`} size="sm">
            Cancelar
          </Anchor>
        }
      />
      {error && <Alert color="red">{error.message}</Alert>}
      {loading && <Skeleton height={420} />}
      {!loading && !data && <Alert color="yellow">Produto não encontrado.</Alert>}
      {!loading && data && (
        <ProdutoForm
          defaultValues={data.data}
          submitLabel="Salvar alterações"
          onSubmit={handleSubmit}
        />
      )}
      {!loading && (
        <Group>
          <Button component={Link} href="/produtos" variant="subtle">
            Voltar à lista
          </Button>
        </Group>
      )}
    </Stack>
  );
}
