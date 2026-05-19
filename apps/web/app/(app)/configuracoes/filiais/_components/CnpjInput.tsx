'use client';

import { TextInput } from '@mantine/core';
import { formatCNPJ } from '@delfrance/core/documents';
import type { FieldRenderProps } from '@delfrance/ui';

/**
 * `renderInput` for the Filial `cnpj` field. A Filial is always a legal
 * entity, so the input is CNPJ-only (14 digits). Stores digits-only (the Zod
 * schema's `^\d*$` regex rejects punctuation) and previews the masked form.
 */
export function CnpjInput({
  value,
  onChange,
  onBlur,
  error,
  label,
  hint,
  disabled,
}: FieldRenderProps) {
  const v = (value as string | null | undefined) ?? '';
  const formatted = v.length === 14 ? formatCNPJ(v) : null;
  return (
    <TextInput
      label={label}
      description={formatted ?? hint ?? 'Apenas números'}
      value={v}
      onChange={(e) => onChange(e.currentTarget.value.replace(/\D/g, ''))}
      onBlur={onBlur}
      error={error}
      disabled={disabled}
      maxLength={14}
      inputMode="numeric"
    />
  );
}
