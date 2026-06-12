'use client';

import { TextInput } from '@mantine/core';
import { formatCNPJ, formatCPF } from '@delfrance/core/documents';
import type { FieldRenderProps } from '@delfrance/ui';

const DEFAULT_HINT = 'CPF (11 dígitos) ou CNPJ (14 — pode conter letras)';

export interface CpfCnpjTextInputProps {
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  label?: string;
  description?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
}

/**
 * CPF/CNPJ input for the uppercase-alphanumeric wire format. Typing is
 * uppercased and common punctuation is stripped on the fly (so pasting
 * `12.ABC.345/01DE-35` works); the description previews the formatted
 * document once the length matches CPF or CNPJ. No `inputMode="numeric"` —
 * the alphanumeric CNPJ (IN RFB 2.229/2024) contains letters.
 */
export function CpfCnpjTextInput({
  value,
  onChange,
  onBlur,
  label,
  description,
  error,
  disabled,
  required,
}: CpfCnpjTextInputProps) {
  const formatted = /^\d{11}$/.test(value)
    ? formatCPF(value)
    : /^[0-9A-Z]{14}$/.test(value)
      ? formatCNPJ(value)
      : null;
  return (
    <TextInput
      label={label}
      description={formatted ?? description ?? DEFAULT_HINT}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value.toUpperCase().replace(/[.\-/\s]/g, ''))}
      onBlur={onBlur}
      error={error}
      maxLength={14}
      disabled={disabled}
      required={required}
    />
  );
}

/** ObjectView `renderInput` adapter. */
export function CpfCnpjField({
  value,
  onChange,
  onBlur,
  error,
  label,
  hint,
  disabled,
}: FieldRenderProps) {
  return (
    <CpfCnpjTextInput
      value={(value as string | null | undefined) ?? ''}
      onChange={onChange}
      onBlur={onBlur}
      label={label}
      description={hint}
      error={error}
      disabled={disabled}
    />
  );
}
