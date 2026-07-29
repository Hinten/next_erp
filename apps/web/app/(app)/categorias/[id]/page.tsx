'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { categoriaSchema, type ImpostoCategoria } from '@delfrance/schemas';
import { type FieldConfig, ObjectView } from '@delfrance/ui';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { buildCategoriaImpostoTransactionWrites } from '@/lib/categorias/clientPort';
import {
  cascadeCategoriaNomeCompleto,
  listDescendantIdsForPicker,
} from '@/lib/categorias/cascadeNomeCompleto';
import { deriveNomeCompletoOnSave } from '@/lib/categorias/nomeCompleto';
import { CategoriaImpostoManager } from '../_components/CategoriaImpostoManager';
import { CategoriaParentField } from '../_components/CategoriaParentField';

// Wider page schema: the categoria doc + a transient `impostos` host field
// (per-operação imposto docs, persisted via transactionWrites, never
// written to the categoria doc). categoriaSchema has no refine, so `.extend` is safe.
const categoriaPageSchema = categoriaSchema.extend({
  impostos: z.unknown().nullable().default(null),
});

const CATEGORIA_SECTIONS = ['Dados gerais', 'Impostos'];
const CATEGORIA_EXCLUDED = ['timestamp', 'ultimaModificacao'];
const CATEGORIA_TRANSIENT = ['impostos'];

export default function CategoriaPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.categoria.write);
  const db = getFirebaseFirestore();
  const parentBreadcrumbRef = useRef<string | null>(null);
  /** True only when deriveOnSave produced a different `nomeCompleto`. */
  const shouldCascadeRef = useRef(false);
  const onParentBreadcrumbChange = useCallback((bc: string | null) => {
    parentBreadcrumbRef.current = bc;
  }, []);
  const [excludeIds, setExcludeIds] = useState<string[]>([params.id]);

  // Self + descendants cannot be selected as parent (cycle guard).
  useEffect(() => {
    let cancelled = false;
    void listDescendantIdsForPicker(db, params.id).then((descendants) => {
      if (!cancelled) setExcludeIds([params.id, ...descendants]);
    });
    return () => {
      cancelled = true;
    };
  }, [db, params.id]);

  async function handleDelete(id: string) {
    await deleteDoc(categoriaCollection.docRef(db, {}, id));
    router.replace('/categorias');
  }

  const fields = useMemo<Record<string, FieldConfig>>(
    () => ({
      categoriaPaiOuterRef: {
        label: 'Categoria pai',
        section: 'Dados gerais',
        hint: 'Opcional. O nome completo é montado a partir da cadeia de pais.',
        renderInput: (p) => (
          <CategoriaParentField
            {...p}
            onParentBreadcrumbChange={onParentBreadcrumbChange}
            excludeIds={excludeIds}
          />
        ),
      },
      nomeCompleto: {
        section: 'Dados gerais',
        editable: false,
        hint: 'Preenchido automaticamente a partir do nome e da categoria pai.',
      },
      impostos: {
        section: 'Impostos',
        label: 'Impostos',
        renderInput: (p) => (
          <CategoriaImpostoManager
            categoriaId={params.id}
            db={db}
            value={(p.value as ImpostoCategoria[] | null) ?? null}
            onChange={p.onChange}
            errorTree={p.errorTree}
            disabled={p.disabled}
          />
        ),
      },
    }),
    [params.id, db, onParentBreadcrumbChange, excludeIds],
  );

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Categoria</Title>
        <Anchor component={Link} href="/categorias" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={categoriaPageSchema}
        collection={categoriaCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        sections={CATEGORIA_SECTIONS}
        fields={fields}
        excludedFields={CATEGORIA_EXCLUDED}
        transientFields={CATEGORIA_TRANSIENT}
        transactionWrites={(id, values) => buildCategoriaImpostoTransactionWrites(db, id, values)}
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
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canWrite}
        onDelete={handleDelete}
        onSaved={() => router.replace('/categorias')}
      />
    </Stack>
  );
}
