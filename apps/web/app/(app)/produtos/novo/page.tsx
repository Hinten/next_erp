'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { addDoc } from 'firebase/firestore';
import { Button, Stack } from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import type { Produto } from '@delfrance/schemas';
import { ProdutoForm } from '../_components/ProdutoForm';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export default function NovoProdutoPage() {
  const router = useRouter();

  async function handleSubmit(values: Produto) {
    const ref = await addDoc(produtoCollection.ref(getFirebaseFirestore(), {}), values);
    router.replace(`/produtos/${ref.id}`);
  }

  return (
    <Stack>
      <PageHeader
        title="Novo produto"
        actions={
          <Button component={Link} href="/produtos" variant="subtle">
            Voltar
          </Button>
        }
      />
      <ProdutoForm submitLabel="Criar" onSubmit={handleSubmit} />
    </Stack>
  );
}
