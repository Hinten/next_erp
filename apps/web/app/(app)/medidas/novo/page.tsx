'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { type Foto, deriveFotosArquivosIds, tabelaDeMedidasSchema } from '@delfrance/schemas';
import { nowMillis } from '@delfrance/core/datetime';
import { ObjectView, stripMarkedForDeletion } from '@delfrance/ui';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import { PhotoManager } from '@/components/photo-manager/PhotoManager';
import {
  MEDIDA_EXCLUDED_FIELDS,
  MEDIDA_SECTIONS,
  medidaFieldOverrides,
} from '../_components/medidaFields';

export default function NovaTabelaDeMedidasPage() {
  const router = useRouter();
  const { user } = useAuth();
  const db = getFirebaseFirestore();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova tabela de medidas</Title>
        <Anchor component={Link} href="/medidas" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={tabelaDeMedidasSchema}
        collection={tabelaDeMedidasCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        defaultValues={{ dataCadastro: nowMillis() }}
        sections={MEDIDA_SECTIONS}
        // The marketplace size-chart maps are authored by the marketplace
        // integrations, not this form; excluding them keeps them out of the
        // editor while the dirty-field-patch save leaves them untouched.
        excludedFields={MEDIDA_EXCLUDED_FIELDS}
        fields={{
          ...medidaFieldOverrides,
          fotos: {
            label: 'Fotos da Tabela de Medidas',
            section: 'Fotos',
            prepareForSave: stripMarkedForDeletion,
            // No uploadFoto → save-first: uploads need a saved tabela.
            renderInput: (p) => (
              <PhotoManager
                db={db}
                emptyOwnerMessage="Salve a tabela de medidas para enviar fotos."
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
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/medidas/${id}`)}
      />
    </Stack>
  );
}
