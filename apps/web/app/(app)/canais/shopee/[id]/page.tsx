'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { integracaoSchema } from '@delfrance/schemas';
import { type FieldConfig, ObjectView } from '@delfrance/ui';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { CAMPO_MARCAS_SHOPEE, escritasMarcasDaContaShopee } from '@/lib/shopee/marcasDaConta';
import { RecalcularPrecosCanalAction } from '../../_components/RecalcularPrecosCanalAction';
import { ContaShopeePanel } from '../_components/ContaShopeePanel';
import { MarcasShopeeManager } from '../_components/MarcasShopeeManager';
import { shopeeExcludedFields, shopeeFields } from '../_components/shopeeFieldOverrides';

const SECAO_GERAL = 'Dados gerais';
const SECAO_MARCAS = 'Marcas';
const SECOES = [SECAO_GERAL, SECAO_MARCAS];
/**
 * The Marcas tab stays mounted: it holds staged changes, and a conflict's
 * "Recarregar do servidor" must reach its value (a hidden `<Activity>` panel
 * suspends its subscriptions — see `SectionTabs`). Mounted, its listener also
 * seeds the brands' save baselines from server truth before the tab is opened.
 */
const SECOES_PERSISTENTES = [SECAO_MARCAS];
const CAMPOS_TRANSIENTES = [CAMPO_MARCAS_SHOPEE];

/**
 * The page model: the conta plus ONE transient key, the brand shortlist's
 * STAGED DELTA (`null` = nothing staged) — rendered here, never written to the
 * `integracao` doc; the save turns it into guarded writes of the conta's
 * `brandshopee` subcollection, in the same commit as the conta.
 *
 * The schema does not validate it (`z.unknown()`): the resolver runs on every
 * save of the conta, and the delta's own schema is applied where the writes are
 * built (`lib/shopee/marcasDaConta.ts`), only when something is staged.
 */
const contaShopeePaginaSchema = integracaoSchema.extend({
  [CAMPO_MARCAS_SHOPEE]: z.unknown().nullable().default(null).describe('Marcas'),
});

export default function ContaShopeePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const { allowed: canDelete } = usePermission(PERM.integracao.delete);
  const db = getFirebaseFirestore();
  const integracaoId = params.id;

  const fields = useMemo<Record<string, FieldConfig>>(
    () => ({
      ...shopeeFields,
      [CAMPO_MARCAS_SHOPEE]: {
        label: 'Marcas',
        section: SECAO_MARCAS,
        renderInput: (p) => (
          <MarcasShopeeManager
            db={db}
            integracaoId={integracaoId}
            value={p.value}
            onChange={p.onChange}
            disabled={p.disabled}
            // The rules' delete bit for `brandshopee` is the conta's own.
            podeRemover={canDelete}
          />
        ),
      },
    }),
    [db, integracaoId, canDelete],
  );

  async function handleDelete(id: string) {
    await deleteDoc(integracaoCollection.docRef(db, {}, id));
    router.replace('/canais/shopee');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Conta Shopee</Title>
        <Group gap="sm">
          {/* Channel-agnostic: it recalculates produto prices for whichever
              integração this page is showing. */}
          <RecalcularPrecosCanalAction integracaoId={integracaoId} />
          <Anchor component={Link} href="/canais/shopee" size="sm">
            ← Voltar à lista
          </Anchor>
        </Group>
      </Group>

      {/* key: a param-only A->B navigation must remount the panel — its local
          state is per-conta (an in-flight `connecting`, and the one-shot
          ?shopee=connected toast effect), and Next reuses the component across
          a param change. */}
      <ContaShopeePanel key={integracaoId} integracaoId={integracaoId} />

      {/* One form, one "Salvar": the conta fields and the staged brand
          registrations / removals commit together, the brands as guarded
          sibling writes that are skipped when nothing is staged. */}
      <ObjectView
        schema={contaShopeePaginaSchema}
        collection={integracaoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={integracaoId}
        sections={SECOES}
        persistentSections={SECOES_PERSISTENTES}
        excludedFields={shopeeExcludedFields}
        fields={fields}
        transientFields={CAMPOS_TRANSIENTES}
        transactionWrites={(_id, values, context) =>
          escritasMarcasDaContaShopee(db, integracaoId, values, context)
        }
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canDelete}
        onDelete={handleDelete}
        onSaved={() => router.replace('/canais/shopee')}
      />
    </Stack>
  );
}
