'use client';

import type { ReactNode } from 'react';
import { TextInput } from '@mantine/core';
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
  /** Optional trailing adornment (e.g. the CNPJ "buscar dados" action). */
  rightSection?: ReactNode;
}

/** Strip a typed/pasted value down to the clean wire format (uppercase
 *  alphanumeric, max 14). Punctuation, spaces and lowercase are removed, so a
 *  pasted `95.473.997/0001-03` becomes `95473997000103`. */
function cleanDocumento(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, 14);
}

/** Live display mask over the clean value: CPF `###.###.###-##`, CNPJ
 *  `##.###.###/####-##`. A clean value with a letter or >11 chars is a CNPJ
 *  (CPF is numeric, 11 digits). Partial values format as far as they go. */
function maskDocumento(clean: string): string {
  const isCnpj = clean.length > 11 || /[A-Z]/.test(clean);
  const groups = isCnpj ? [2, 3, 3, 4, 2] : [3, 3, 3, 2];
  const seps = isCnpj ? ['.', '.', '/', '-'] : ['.', '.', '-'];
  let out = '';
  let i = 0;
  for (let g = 0; g < groups.length && i < clean.length; g++) {
    const size = groups[g] ?? 0;
    if (g > 0) out += seps[g - 1] ?? '';
    out += clean.slice(i, i + size);
    i += size;
  }
  return out;
}

/**
 * CPF/CNPJ input for the uppercase-alphanumeric wire format. The field shows a
 * live mask (`95.473.997/0001-03`) while emitting the clean value, and pasting
 * a formatted document works (punctuation is stripped before the 14-char cap —
 * the old `maxLength={14}` truncated an 18-char paste before cleaning). No
 * `inputMode="numeric"`: the alphanumeric CNPJ (IN RFB 2.229/2024) has letters.
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
  rightSection,
}: CpfCnpjTextInputProps) {
  return (
    <TextInput
      label={label}
      description={description ?? DEFAULT_HINT}
      value={maskDocumento(value)}
      onChange={(e) => onChange(cleanDocumento(e.currentTarget.value))}
      onBlur={onBlur}
      error={error}
      disabled={disabled}
      required={required}
      rightSection={rightSection}
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
