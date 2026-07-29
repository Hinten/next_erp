'use client';

import { useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { categoriaSchema } from '@delfrance/schemas';
import { type FieldConfig, ObjectView } from '@delfrance/ui';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import { cascadeCategoriaNomeCompleto } from '@/lib/categorias/cascadeNomeCompleto';
import { deriveNomeCompletoOnSave } from '@/lib/categorias/nomeCompleto';
import { CategoriaParentField } from '../_components/CategoriaParentField';

export default function NovaCategoriaPage() {
  const router = useRouter();
  const { user } = useAuth();
  const db = getFirebaseFirestore();
  const parentBreadcrumbRef = useRef<string | null>(null);
  /** True only when deriveOnSave produced a different `nomeCompleto`. */
  const shouldCascadeRef = useRef(false);
  const onParentBreadcrumbChange = useCallback((bc: string | null) => {
    parentBreadcrumbRef.current = bc;
  }, []);

  const fields = useMemo<Record<string, FieldConfig>>(
    () => ({
      categoriaPaiOuterRef: {
        label: 'Categoria pai',
        hint: 'Opcional. O nome completo é montado a partir da cadeia de pais.',
        renderInput: (p) => (
          <CategoriaParentField {...p} onParentBreadcrumbChange={onParentBreadcrumbChange} />
        ),
      },
      nomeCompleto: {
        editable: false,
        hint: 'Preenchido automaticamente a partir do nome e da categoria pai.',
      },
    }),
    [onParentBreadcrumbChange],
  );

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova categoria</Title>
        <Anchor component={Link} href="/categorias" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={categoriaSchema}
        collection={categoriaCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{
          permiteCadastro: true,
        }}
        fields={fields}
        excludedFields={['timestamp', 'ultimaModificacao']}
        deriveOnSave={(values) => {
          const existing = typeof values.nomeCompleto === 'string' ? values.nomeCompleto : null;
          const nomeCompleto = deriveNomeCompletoOnSave({
            nome: String(values.nome ?? ''),
            hasParent: values.categoriaPaiOuterRef != null && values.categoriaPaiOuterRef !== '',
            parentBreadcrumb: parentBreadcrumbRef.current,
            existingNomeCompleto: existing,
          });
          shouldCascadeRef.current = nomeCompleto !== existing;
          return { nomeCompleto };
        }}
        onAfterSave={async (id, values) => {
          if (!shouldCascadeRef.current) return;
          shouldCascadeRef.current = false;
          const nc = values.nomeCompleto;
          if (typeof nc === 'string' && nc.length > 0) {
            await cascadeCategoriaNomeCompleto(db, id, nc);
          }
        }}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/categorias/${id}`)}
      />
    </Stack>
  );
}
