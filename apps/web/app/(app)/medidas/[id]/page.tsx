'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import {
  type Foto,
  buildOriginalFotoRef,
  deriveFotosArquivosIds,
  tabelaDeMedidasSchema,
} from '@delfrance/schemas';
import { uploadTabMediImage } from '@delfrance/storage';
import { ObjectView, stripMarkedForDeletion } from '@delfrance/ui';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import { getFirebaseFirestore, getFirebaseStorage } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { PhotoManager } from '@/components/photo-manager/PhotoManager';
import {
  MEDIDA_EXCLUDED_FIELDS,
  MEDIDA_SECTIONS,
  medidaFieldOverrides,
} from '../_components/medidaFields';

export default function TabelaDeMedidasPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.produto.write);
  const db = getFirebaseFirestore();
  const storage = getFirebaseStorage();

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
        sections={MEDIDA_SECTIONS}
        // Marketplace maps stay out of the form; the partial-save patch never
        // touches them, so integration-authored ML/Shopee charts are preserved.
        excludedFields={MEDIDA_EXCLUDED_FIELDS}
        fields={{
          ...medidaFieldOverrides,
          fotos: {
            label: 'Fotos da Tabela de Medidas',
            section: 'Fotos',
            prepareForSave: stripMarkedForDeletion,
            // Original-only upload (no resize for tabMedi) → buildOriginalFotoRef
            // (null derivative refs); the thumbnail falls back to the original.
            renderInput: (p) => (
              <PhotoManager
                db={db}
                uploadFoto={(file) =>
                  uploadTabMediImage({
                    storage,
                    db,
                    tabMediId: params.id,
                    bytes: file,
                    contentType: file.type,
                    originalFilename: file.name,
                  }).then(({ id }) => buildOriginalFotoRef(id))
                }
                value={(p.value as Foto[] | null) ?? null}
                onChange={p.onChange}
                disabled={p.disabled}
              />
            ),
          },
        }}
        deriveOnSave={(values) => {
          const ids = deriveFotosArquivosIds(values.fotos as Foto[] | null);
          return { fotosArquivosIds: ids.length > 0 ? ids : null };
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
