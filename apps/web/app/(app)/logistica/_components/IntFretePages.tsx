'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { deleteDoc } from 'firebase/firestore';
import { Anchor, Badge, Button, Group, Stack, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { type IntFrete, intFreteMeta, intFreteSchema } from '@delfrance/schemas';
import { ObjectView, TableView } from '@delfrance/ui';
import { intFreteCollection } from '@/lib/data/intFreteCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { intFreteFields } from './intFreteFields';
import { SHARED_EXCLUDED, type LogisticaSlice } from './slices';

/**
 * The three shared screens behind every `/logistica/<slug>` slice. Same
 * collection (`int_frete`), discriminated by `tipo` — mirror of the
 * `/canais/balcao` slice over `integracao`. The list binds the slice's `tipo`
 * via intFreteMeta.defaultQuery's `param`, so the per-column filters still
 * work on top of the base filter.
 */

const excludedFor = (slice: LogisticaSlice): string[] => [
  ...SHARED_EXCLUDED,
  ...slice.extraExcluded,
];

export function IntFreteListPage({ slice }: { slice: LogisticaSlice }) {
  const db = getFirebaseFirestore();
  const { allowed: canWrite } = usePermission(PERM.frete.write);
  const { allowed: canDelete } = usePermission(PERM.frete.delete);

  return (
    <TableView<typeof intFreteSchema>
      title={slice.titulo}
      description={slice.descricao}
      schema={intFreteSchema}
      collection={intFreteCollection}
      db={db}
      meta={intFreteMeta}
      queryParams={{ tipo: slice.tipo }}
      rowHref={(id) => `/logistica/${slice.slug}/${id}`}
      // Create/delete affordances only for users holding the matching
      // PERM.frete bits — the backend (rules) is the real gate; hiding
      // them avoids offering flows that would be rejected.
      renderNewButton={
        canWrite
          ? () => (
              <Button component={Link} href={`/logistica/${slice.slug}/novo` as Route}>
                {slice.novoLabel}
              </Button>
            )
          : undefined
      }
      fields={{
        ativo: {
          renderCell: (value) =>
            value ? (
              <Badge color="green" variant="light">
                Ativo
              </Badge>
            ) : (
              <Badge color="gray" variant="light">
                Inativo
              </Badge>
            ),
        },
      }}
      selectable
      actions={
        canDelete
          ? [
              {
                id: 'delete',
                label: 'Excluir',
                color: 'red',
                requiresSelection: true,
                refreshOnComplete: true,
                confirm: {
                  title: `Excluir — ${slice.titulo}`,
                  message:
                    'Configurações de frete excluídas não podem ser restauradas. Confirmar exclusão?',
                },
                run: async (rows) => {
                  await Promise.all(
                    rows.map((r: { id: string; data: IntFrete }) =>
                      deleteDoc(intFreteCollection.docRef(db, {}, r.id)),
                    ),
                  );
                },
              },
            ]
          : []
      }
    />
  );
}

export function IntFreteCreatePage({ slice }: { slice: LogisticaSlice }) {
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.frete.write);
  // `dataCadastro` is required (non-nullable) for legacy wire parity — seed a
  // provisional epoch so the form validates; saveRecord re-stamps on create
  // only when the value is nullish, so a real create time still comes from
  // page open here (required fields are absent from emptyDefaults).
  const [dataCadastro] = useState(() => Date.now());

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>{slice.tituloNovo}</Title>
        <Anchor component={Link} href={`/logistica/${slice.slug}` as Route} size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={intFreteSchema}
        collection={intFreteCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{
          tipo: slice.tipo,
          ativo: true,
          prazoExtra: 0,
          dataCadastro,
        }}
        excludedFields={excludedFor(slice)}
        fields={intFreteFields}
        sections={[...slice.sections]}
        saveLabel="Criar"
        showSaveAndContinue={false}
        canEdit={canWrite}
        readOnly={!canWrite}
        onSaved={(id) => router.replace(`/logistica/${slice.slug}/${id}` as Route)}
      />
    </Stack>
  );
}

export function IntFreteEditPage({ slice }: { slice: LogisticaSlice }) {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.frete.write);
  const { allowed: canDelete } = usePermission(PERM.frete.delete);
  const db = getFirebaseFirestore();

  async function handleDelete(id: string) {
    await deleteDoc(intFreteCollection.docRef(db, {}, id));
    router.replace(`/logistica/${slice.slug}` as Route);
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>{slice.titulo}</Title>
        <Anchor component={Link} href={`/logistica/${slice.slug}` as Route} size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={intFreteSchema}
        collection={intFreteCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        excludedFields={excludedFor(slice)}
        fields={intFreteFields}
        sections={[...slice.sections]}
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canDelete}
        onDelete={handleDelete}
        onSaved={() => router.replace(`/logistica/${slice.slug}` as Route)}
      />
    </Stack>
  );
}
