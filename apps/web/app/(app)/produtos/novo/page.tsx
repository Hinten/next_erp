'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Stack } from '@mantine/core';
import { ObjectView, PageHeader } from '@delfrance/ui';
import { produtoSchema } from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import {
  PRODUTO_CREATE_DEFAULTS,
  PRODUTO_EXCLUDED_FIELDS,
  PRODUTO_SECTIONS,
  produtoFieldOverrides,
} from '../_components/produtoFields';

export default function NovoProdutoPage() {
  const router = useRouter();
  const { user } = useAuth();

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
      <ObjectView
        schema={produtoSchema}
        collection={produtoCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={PRODUTO_CREATE_DEFAULTS}
        sections={PRODUTO_SECTIONS}
        fields={produtoFieldOverrides}
        excludedFields={PRODUTO_EXCLUDED_FIELDS}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/produtos/${id}`)}
      />
    </Stack>
  );
}
