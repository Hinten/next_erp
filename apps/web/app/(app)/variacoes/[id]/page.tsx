'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { grupoDeVariacoesSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import {
  GRUPO_EXCLUDED_FIELDS_EDICAO,
  GRUPO_PERSISTENT_SECTIONS_EDICAO,
  GRUPO_SECTIONS_EDICAO,
  VINCULADOR_LI_VISIVEL,
  VINCULADOR_SHOPEE_VISIVEL,
  deriveVariacoesIds,
  grupoFields,
} from '../_components/grupoFields';
import {
  EstadoVinculadorLiProvider,
  useEstadoVinculadorLi,
} from '../_components/estadoVinculadorLi';
import {
  EstadoVinculadorShopeeProvider,
  useEstadoVinculadorShopee,
} from '../_components/estadoVinculadorShopee';

export default function GrupoVariacaoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.produto.write);
  const { allowed: canDelete } = usePermission(PERM.produto.delete);
  const db = getFirebaseFirestore();
  // Each link tab publishes the form's seed to its state; `validar` checks the
  // links this save edits against it (see `estadoVinculadorLi`).
  const estadoLi = useEstadoVinculadorLi();
  const estadoShopee = useEstadoVinculadorShopee();
  // A stable identity: `ObjectView` rebuilds its resolver whenever `validate` changes.
  const validate = useMemo(
    () =>
      VINCULADOR_LI_VISIVEL || VINCULADOR_SHOPEE_VISIVEL
        ? (values: Record<string, unknown>) => [
            ...(VINCULADOR_LI_VISIVEL ? estadoLi.validar(values) : []),
            ...(VINCULADOR_SHOPEE_VISIVEL ? estadoShopee.validar(values) : []),
          ]
        : undefined,
    [estadoLi, estadoShopee],
  );

  async function handleDelete(id: string) {
    await deleteDoc(grupoDeVariacoesCollection.docRef(db, {}, id));
    router.replace('/variacoes');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Grupo de variação</Title>
        <Anchor component={Link} href="/variacoes" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <EstadoVinculadorLiProvider value={estadoLi}>
        <EstadoVinculadorShopeeProvider value={estadoShopee}>
          <ObjectView
            schema={grupoDeVariacoesSchema}
            collection={grupoDeVariacoesCollection}
            db={db}
            currentUserUid={user?.uid ?? ''}
            recordId={params.id}
            sections={GRUPO_SECTIONS_EDICAO}
            persistentSections={GRUPO_PERSISTENT_SECTIONS_EDICAO}
            fields={grupoFields}
            excludedFields={GRUPO_EXCLUDED_FIELDS_EDICAO}
            deriveOnSave={deriveVariacoesIds}
            validate={validate}
            saveLabel="Salvar alterações"
            canEdit={canWrite}
            readOnly={!canWrite}
            canDelete={canDelete}
            onDelete={handleDelete}
            onSaved={() => router.replace('/variacoes')}
          />
        </EstadoVinculadorShopeeProvider>
      </EstadoVinculadorLiProvider>
    </Stack>
  );
}
