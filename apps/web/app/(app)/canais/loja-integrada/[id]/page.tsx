'use client';

import { useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { deleteDoc } from 'firebase/firestore';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { integracaoSchema } from '@delfrance/schemas';
import { type FieldConfig, ObjectView, type TransactionWriteContext } from '@delfrance/ui';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import {
  CAMPO_HORARIO_CORTE_LI,
  CAMPO_MAPA_FRETE_LI,
  escritasFreteDaContaLi,
  problemasDoFreteDaContaLi,
} from '@/lib/loja-integrada/freteDaConta';
import { intFreteFields } from '@/app/(app)/logistica/_components/intFreteFields';
import { RecalcularPrecosCanalAction } from '../../_components/RecalcularPrecosCanalAction';
import { ContaLojaIntegradaPanel } from '../_components/ContaLojaIntegradaPanel';
import { HorarioCorteManager } from '../_components/HorarioCorteManager';
import { MapaFreteManager } from '../_components/MapaFreteManager';
import {
  lojaIntegradaExcludedFields,
  lojaIntegradaFields,
} from '../_components/lojaIntegradaFieldOverrides';
import { intFreteIdDe, useFreteDaContaLi } from '../_components/useFreteDaContaLi';

const SECAO_GERAL = 'Dados gerais';
const SECAO_MAPA = 'Mapeamento do Frete';
const SECAO_HORARIO = 'Horário de Corte';
const SECOES = [SECAO_GERAL, SECAO_MAPA, SECAO_HORARIO];
/**
 * Both freight tabs stay mounted: they hold unsaved edits, and a conflict's
 * "reload from server" must reach their inputs (a hidden `<Activity>` panel
 * suspends its subscriptions — see `SectionTabs`).
 */
const SECOES_PERSISTENTES = [SECAO_MAPA, SECAO_HORARIO];
const CAMPOS_TRANSIENTES = [CAMPO_MAPA_FRETE_LI, CAMPO_HORARIO_CORTE_LI];

/**
 * The page model: the conta plus its freight doc's `mapa` and `horarioDeCorte`,
 * as two TRANSIENT keys — rendered here, never written to the `integracao` doc;
 * the save writes them to the freight doc instead.
 *
 * Neither is validated by the SCHEMA: both are the stored values RAW, corpus
 * shapes these schemas do not model included, and the schema resolver runs on
 * every save of the conta — so a strict rule there would let an untouched
 * stored value block renaming the conta over a tab nobody opened.
 *
 * - `freteMapa` is validated by nothing: the editor only ever replaces one
 *   row's target fields.
 * - `freteHorarioDeCorte` gets the freight schema's own rule (one row per
 *   weekday, hours in range) from `problemasDoFreteDaContaLi`, ONLY when the
 *   save would write it — the operator changed it — and the refusal shows on
 *   its tab.
 */
const contaLojaIntegradaPaginaSchema = integracaoSchema.extend({
  [CAMPO_MAPA_FRETE_LI]: z.unknown().nullable().default(null).describe('Mapeamento do frete'),
  [CAMPO_HORARIO_CORTE_LI]: z.unknown().nullable().default(null).describe('Horários de corte'),
});

export default function ContaLojaIntegradaPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const { allowed: canDelete } = usePermission(PERM.integracao.delete);
  const db = getFirebaseFirestore();
  // ONE listener for both freight tabs; the doc it names is frozen once found.
  const frete = useFreteDaContaLi(db, params.id);
  const intFreteId = intFreteIdDe(frete);

  const fields = useMemo<Record<string, FieldConfig>>(
    () => ({
      ...lojaIntegradaFields,
      [CAMPO_MAPA_FRETE_LI]: {
        label: 'Mapeamento do frete',
        section: SECAO_MAPA,
        renderInput: (p) => (
          <MapaFreteManager
            db={db}
            frete={frete}
            value={p.value}
            onChange={p.onChange}
            disabled={p.disabled}
          />
        ),
      },
      [CAMPO_HORARIO_CORTE_LI]: {
        label: 'Horários de corte',
        section: SECAO_HORARIO,
        // The /logistica editor's own save-time transform: staged deletions
        // dropped, an emptied list stored as null.
        prepareForSave: intFreteFields.horarioDeCorte?.prepareForSave,
        renderInput: (p) => <HorarioCorteManager db={db} frete={frete} {...p} />,
      },
    }),
    [db, frete],
  );

  // The horário's rule, run only when this save would write it (see the page
  // model above); the same doc and baseline the save's sibling write uses.
  const validate = useCallback(
    (values: Record<string, unknown>, context: TransactionWriteContext) =>
      problemasDoFreteDaContaLi(db, intFreteId, values, context),
    [db, intFreteId],
  );

  async function handleDelete(id: string) {
    await deleteDoc(integracaoCollection.docRef(db, {}, id));
    router.replace('/canais/loja-integrada');
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Conta Loja Integrada</Title>
        <Group gap="sm">
          {/* Channel-agnostic: it recalculates produto prices for whichever
              integração this page is showing. */}
          <RecalcularPrecosCanalAction integracaoId={params.id} />
          <Anchor component={Link} href="/canais/loja-integrada" size="sm">
            ← Voltar à lista
          </Anchor>
        </Group>
      </Group>

      {/* The credential panel sits ABOVE the form and is always visible, so the
          expiry and "token recusado" avisos' deep link lands on it. key: a
          param-only A->B navigation must remount it — its state is per-conta (a
          typed token, a picked date, the last write's message), and Next reuses
          the component across a param change. */}
      <ContaLojaIntegradaPanel key={params.id} integracaoId={params.id} />

      {/* One form, one "Salvar": the conta fields and its freight doc's two tabs
          commit together, the freight doc as a guarded sibling write that is
          skipped when neither tab changed. */}
      <ObjectView
        schema={contaLojaIntegradaPaginaSchema}
        collection={integracaoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        sections={SECOES}
        persistentSections={SECOES_PERSISTENTES}
        excludedFields={lojaIntegradaExcludedFields}
        fields={fields}
        transientFields={CAMPOS_TRANSIENTES}
        validate={validate}
        transactionWrites={(_id, values, context) =>
          escritasFreteDaContaLi(db, intFreteId, values, context)
        }
        saveLabel="Salvar alterações"
        canEdit={canWrite}
        readOnly={!canWrite}
        canDelete={canDelete}
        onDelete={handleDelete}
        onSaved={() => router.replace('/canais/loja-integrada')}
      />
    </Stack>
  );
}
