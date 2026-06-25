'use client';

import type { FieldConfig, FieldRenderProps } from '@delfrance/ui';
import { RECENCY_SORT } from '@delfrance/schemas';
import { filialCollection } from '@/lib/data/filialCollection';
import { CollectionSelect } from '@/components/collection-select/CollectionSelect';

/**
 * Optimized filial selector — the shared picker for every screen that
 * references a filial (logistica, balcão, …).
 *
 * - Initial load capped at **5** docs, ordered by recency:
 *   `ultimaModificacao desc, timestamp desc`. Pipeline sorts treat a missing
 *   field as null (legacy Flutter-written filiais sort last) instead of
 *   excluding the doc like a classic `orderBy` would.
 * - Typing triggers the pipeline **regex** search (case/accent-insensitive
 *   `regexContains` — see `buildSimilarityPattern` in @delfrance/data)
 *   across razão social, fantasia and CNPJ — so any filial is reachable
 *   regardless of the 5-doc initial window.
 * - Emits the Flutter-ODM doc-path string `documents/filiais/<id>` for every
 *   filial ref (`int_frete`, `integracao`, the NF-e export filter, …).
 */

const INITIAL_LIMIT = 5;
const SEARCH_FIELDS = ['razaoSocial', 'fantasia', 'cnpj'];

export interface FilialPickerProps {
  fieldName: string;
  value: unknown;
  onChange: (next: unknown) => void;
  onBlur?: () => void;
  label?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
}

export function FilialPicker({
  fieldName,
  value,
  onChange,
  onBlur,
  label = 'Filial',
  hint,
  required,
  disabled,
  error,
}: FilialPickerProps) {
  return (
    <CollectionSelect
      collection={filialCollection}
      labelField="razaoSocial"
      searchFields={SEARCH_FIELDS}
      fieldName={fieldName}
      label={label}
      hint={hint}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      disabled={disabled}
      error={error}
      required={required}
      limit={INITIAL_LIMIT}
      orderBy={RECENCY_SORT}
    />
  );
}

/**
 * `FieldConfig.renderInput` wiring for schema-driven ObjectViews.
 */
export function filialRefRenderInput(required: boolean): FieldConfig['renderInput'] {
  function FilialRefInput(props: FieldRenderProps) {
    return (
      <FilialPicker
        fieldName={props.name}
        label={props.label}
        hint={props.hint}
        value={props.value}
        onChange={props.onChange}
        onBlur={props.onBlur}
        disabled={props.disabled}
        error={props.error}
        required={required}
      />
    );
  }
  return FilialRefInput;
}
