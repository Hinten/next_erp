'use client';

import { Select } from '@mantine/core';
import { type FieldConfig, stripMarkedForDeletion } from '@delfrance/ui';
import { TIPO_VARIACAO_LABELS, type Variante } from '@delfrance/schemas';
import { VarianteEditor } from './VarianteEditor';

/**
 * Shared ObjectView configuration for the `grupoDeVariacoes` create (`novo`)
 * and edit (`[id]`) screens, so labels, tabs and the custom inputs stay in sync.
 */

/** Tab order for the grupo ObjectView. */
export const GRUPO_SECTIONS: string[] = ['Dados gerais', 'Variantes'];

/**
 * Fields hidden from the grupo ObjectView: audit stamps, the denormalized id
 * list (`variacoesIds` is derived on save), and the marketplace link arrays
 * (Shopee / Loja Integrada / Amazon) that only the legacy app ever authored.
 */
export const GRUPO_EXCLUDED_FIELDS: string[] = [
  'timestamp',
  'ultimaModificacao',
  'variacoesIds',
  'linksVariacoesShopee',
  'linksVariacoesli',
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
 * deletions via `stripMarkedForDeletion`.
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
};
