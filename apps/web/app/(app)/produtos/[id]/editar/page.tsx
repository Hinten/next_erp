'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Stack } from '@mantine/core';
import { ObjectView, PageHeader } from '@delfrance/ui';
import { PERM } from '@delfrance/auth';
import { produtoSchema } from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import {
  PRODUTO_EXCLUDED_FIELDS,
  PRODUTO_SECTIONS,
  produtoFieldOverrides,
} from '../../_components/produtoFields';

export default function EditarProdutoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.produto.write);

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
      <ObjectView
        schema={produtoSchema}
        collection={produtoCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        sections={PRODUTO_SECTIONS}
        fields={produtoFieldOverrides}
        excludedFields={PRODUTO_EXCLUDED_FIELDS}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        onSaved={() => router.replace(`/produtos/${params.id}`)}
      />
    </Stack>
  );
}
