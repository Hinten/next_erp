'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import {
  type Foto,
  buildFotoRefsFromArquivoId,
  deriveFotosArquivosIds,
  tabelaDeMedidasSchema,
} from '@delfrance/schemas';
import { uploadTabMediImage } from '@delfrance/storage';
import { ObjectView, stripMarkedForDeletion } from '@delfrance/ui';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import { getFirebaseFirestore, getFirebaseStorage } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { PhotoManager } from '@/components/photo-manager/PhotoManager';
import { prepararTabelasShopeeParaSalvar } from '@/lib/shopee/tabelasMedidasForm';
import {
  MEDIDA_EXCLUDED_FIELDS_EDITAR,
  MEDIDA_SECTIONS,
  medidaFieldOverrides,
} from '../_components/medidaFields';
import { MedidasMercadoLivreManager } from '../_components/MedidasMercadoLivreManager';
import { MedidasShopeeManager } from '../_components/MedidasShopeeManager';

/**
 * Edit-only schema: the aggregate plus the `mercadoLivre` UI anchor — a
 * transient key whose only job is to give the Mercado Livre tab a field
 * descriptor (the tab is self-contained; nothing is read from or written to
 * the form value). Edit-only because chart sync needs a SAVED tabela id.
 */
const tabelaDeMedidasEditarSchema = tabelaDeMedidasSchema.extend({
  mercadoLivre: z.null().default(null),
});

const MEDIDA_SECTIONS_EDITAR = [...MEDIDA_SECTIONS, 'Mercado Livre', 'Shopee'];
const MEDIDA_TRANSIENT_FIELDS_EDITAR = ['mercadoLivre'];

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
        schema={tabelaDeMedidasEditarSchema}
        collection={tabelaDeMedidasCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        sections={MEDIDA_SECTIONS_EDITAR}
        transientFields={MEDIDA_TRANSIENT_FIELDS_EDITAR}
        // The ML map stays out of the form (the ML tab writes it itself), so the
        // partial-save patch never touches it. The Shopee map is IN the form
        // here: its tab stages picks and this save writes them (below).
        excludedFields={MEDIDA_EXCLUDED_FIELDS_EDITAR}
        fields={{
          ...medidaFieldOverrides,
          tabelasMedidasShopee: {
            label: 'Shopee',
            section: 'Shopee',
            // Staged, never immediate (web rule 7): the tab marks a removal and
            // this drops it, per conta, only when the tabela is saved. The
            // save's `tx.update` replaces the whole map, and #1757's baseline
            // guard raises the conflict modal if the stored map changed since
            // load — no transaction of its own (root rule 7, tier 3).
            prepareForSave: prepararTabelasShopeeParaSalvar,
            renderInput: (p) => (
              <MedidasShopeeManager
                db={db}
                value={p.value}
                onChange={p.onChange}
                disabled={p.disabled}
              />
            ),
          },
          mercadoLivre: {
            label: 'Mercado Livre',
            section: 'Mercado Livre',
            // Self-contained tab: reads live doc state + drives the size-chart
            // sync endpoint, decoupled from this form's save.
            renderInput: (p) => (
              <MedidasMercadoLivreManager tabMediId={params.id} db={db} disabled={p.disabled} />
            ),
          },
          fotos: {
            label: 'Fotos da Tabela de Medidas',
            section: 'Fotos',
            prepareForSave: stripMarkedForDeletion,
            // Resized like product photos: the trigger writes the 200/400/jpeg
            // derivatives, so the refs are built optimistically from the
            // original's doc id. The thumbnail stops loading the full original,
            // and the size-chart AI agent gets a `jpeg` variant it can read
            // measurements from.
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
                  }).then(({ id }) => buildFotoRefsFromArquivoId(id))
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
