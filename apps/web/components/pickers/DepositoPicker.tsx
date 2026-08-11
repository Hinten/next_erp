'use client';

import type { FieldConfig, FieldRenderProps } from '@delfrance/ui';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { CollectionSelect } from '@/components/collection-select/CollectionSelect';

/**
 * Depósito selector — the shared picker for every screen that references a
 * depósito by `documents/depositos/<id>`.
 *
 * Only ACTIVE depósitos are offered: counting into a deactivated warehouse is
 * never what an operator means, and a balanço binds its depósito at creation
 * and can never change it afterwards.
 *
 * Ordering is the default `nome asc`, which the existing `depositos(nome)`
 * index already covers — no recency sort, so no new index and no
 * `pickerRecencySort` flag on the meta.
 */
export interface DepositoPickerProps {
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

export function DepositoPicker({
  fieldName,
  value,
  onChange,
  onBlur,
  label = 'Depósito',
  hint,
  required,
  disabled,
  error,
}: DepositoPickerProps) {
  return (
    <CollectionSelect
      collection={depositoCollection}
      labelField="nome"
      fieldName={fieldName}
      label={label}
      hint={hint}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      disabled={disabled}
      error={error}
      required={required}
      filters={[{ field: 'ativo', op: 'eq', value: true }]}
    />
  );
}

/** `FieldConfig.renderInput` wiring for schema-driven ObjectViews. */
export function depositoRefRenderInput(required: boolean): FieldConfig['renderInput'] {
  function DepositoRefInput(props: FieldRenderProps) {
    return (
      <DepositoPicker
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
  return DepositoRefInput;
}
