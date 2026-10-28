'use client';

import { Select } from '@mantine/core';
import { type FieldConfig, stripMarkedForDeletion } from '@delfrance/ui';
import {
  INTEGRACAO_TIPO,
  TIPO_VARIACAO_LABELS,
  marketplaceCapsFor,
  type Variante,
} from '@delfrance/schemas';
import { VarianteEditor } from './VarianteEditor';
import { VinculadorLojaIntegrada } from './VinculadorLojaIntegrada';
import { prepararVinculosLi, rebaseVinculosLi } from './vinculadorLi';

/**
 * Shared ObjectView configuration for the `grupoDeVariacoes` create (`novo`)
 * and edit (`[id]`) screens, so labels, tabs and the custom inputs stay in sync.
 */

/** The tab of the Loja Integrada variation links (master plan step 10). */
export const SECAO_LOJA_INTEGRADA = 'Loja Integrada';

/**
 * Whether the grupo screens carry the Loja Integrada tab: the channel's
 * capability row says it has variations. Deliberately NOT gated on the channel
 * being switched on — the links are ERP data, and the backend refuses every
 * store read by itself until the cutover.
 */
export const VINCULADOR_LI_VISIVEL =
  marketplaceCapsFor(INTEGRACAO_TIPO.lojaIntegrada).variacoes === 'sim';

/** Tab order for the grupo ObjectView. */
export const GRUPO_SECTIONS: string[] = VINCULADOR_LI_VISIVEL
  ? ['Dados gerais', 'Variantes', SECAO_LOJA_INTEGRADA]
  : ['Dados gerais', 'Variantes'];

/**
 * Tabs kept FULLY mounted while hidden: the Loja Integrada tab publishes the
 * form's seed to the page's `validate` from an effect, which must run even when
 * the tab was never opened (it reads the store only while it is the active tab).
 */
export const GRUPO_PERSISTENT_SECTIONS: readonly string[] = VINCULADOR_LI_VISIVEL
  ? [SECAO_LOJA_INTEGRADA]
  : [];

/**
 * Fields hidden from the grupo ObjectView: audit stamps, the denormalized id
 * list (`variacoesIds` is derived on save), and the marketplace link arrays
 * that only the legacy app ever authored (Shopee, Amazon). The Loja Integrada
 * array is authored by its tab.
 */
export const GRUPO_EXCLUDED_FIELDS: string[] = [
  'timestamp',
  'ultimaModificacao',
  'variacoesIds',
  'linksVariacoesShopee',
  ...(VINCULADOR_LI_VISIVEL ? [] : ['linksVariacoesli']),
  'linksVariacoesAmazon',
];

/**
 * Mirror Flutter `GrupoDeVariacoes.save()` (`models.dart:4696`): `variacoesIds`
 * is always the de-duplicated ids of the embedded `variacoes`. Wire as
 * `ObjectView.deriveOnSave` so the denormalized list never drifts from the
 * variants. ⚠️ The stated reason — "Flutter reads `variacoesIds`" — is VOID (no
 * dual run; root `CLAUDE.md` rule 8), yet this still derives on EVERY save in
 * this app. Kept because the migrated corpus carries the field and nothing here
 * has re-derived whether the ERP itself needs it; dropping it is a real
 * decision, not a drive-by edit.
 */
export function deriveVariacoesIds(values: Record<string, unknown>): { variacoesIds: string[] } {
  const variacoes = (values.variacoes as Array<{ id: string }> | null) ?? [];
  return { variacoesIds: [...new Set(variacoes.map((v) => v.id))] };
}

const TIPO_OPTIONS = Object.entries(TIPO_VARIACAO_LABELS).map(([value, label]) => ({
  value,
  label,
}));

/**
 * Per-field overrides. `tipo` is an int-coded enum (0/1/2) the schema models as
 * a union of number literals, so it renders through a custom Select that maps
 * to/from strings; `variacoes` renders the {@link VarianteEditor} and stages
 * deletions via `stripMarkedForDeletion`; `linksVariacoesli` renders the Loja
 * Integrada tab, writes back every entry it did not touch as stored (its
 * `prepareForSave` only drops staged removals and strips the tab's marks), and
 * merges link by link on a conflicting save.
 */
export const grupoFields: Record<string, FieldConfig> = {
  nome: { label: 'Nome', section: 'Dados gerais' },
  codigo: { label: 'Código', section: 'Dados gerais' },
  ordem: {
    label: 'Ordem',
    hint: 'Ordem de exibição (menor primeiro)',
    section: 'Dados gerais',
  },
  permiteFotos: {
    label: 'Permite fotos?',
    hint: 'Permite cadastrar fotos específicas por variante',
    section: 'Dados gerais',
  },
  tipo: {
    label: 'Tipo',
    section: 'Dados gerais',
    renderInput: (p) => (
      <Select
        label={p.label}
        description={p.hint}
        data={TIPO_OPTIONS}
        value={p.value == null ? null : String(p.value)}
        onChange={(v) => p.onChange(v == null ? null : Number(v))}
        onBlur={p.onBlur}
        disabled={p.disabled}
        error={p.error}
        clearable
      />
    ),
  },
  variacoes: {
    label: 'Variantes',
    section: 'Variantes',
    prepareForSave: stripMarkedForDeletion,
    renderInput: (p) => (
      <VarianteEditor
        value={(p.value as Variante[] | null) ?? null}
        onChange={p.onChange}
        disabled={p.disabled}
        error={p.error}
      />
    ),
  },
  linksVariacoesli: {
    label: 'Vínculos da Loja Integrada',
    section: SECAO_LOJA_INTEGRADA,
    prepareForSave: prepararVinculosLi,
    rebaseOnConflict: { label: 'mescla por vínculo', merge: rebaseVinculosLi },
    renderInput: (p) => (
      <VinculadorLojaIntegrada
        value={p.value}
        onChange={p.onChange}
        disabled={p.disabled}
        error={p.error}
      />
    ),
  },
};
