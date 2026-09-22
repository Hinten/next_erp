'use client';

import { TextInput } from '@mantine/core';
import { formatCNPJ } from '@delfrance/core/documents';
import type { FieldRenderProps } from '@delfrance/ui';

import { cleanDocumento } from '@/components/inputs/CpfCnpjInput';

/**
 * `renderInput` for the Filial `cnpj` field. A Filial is always a legal entity,
 * so the input is CNPJ-only — 14 **characters**, not 14 digits.
 *
 * ⚠️ It used to `replace(/\D/g, '')`, which silently ate the letters of an
 * alphanumeric CNPJ (RFB IN 2.229/2024) keystroke by keystroke: typing
 * `12ABC34501DE35` landed on the 9-character `123450135`, which `filialSchema`
 * — `max(18)`, no minimum, no checksum — saved without a word. A corrupt
 * emitente CNPJ with no error anywhere, and downstream
 * `generator/index.ts`'s `padStart(14, '0')` would have zero-padded it into a
 * plausible-looking 14-character value on the chave.
 *
 * The cleaner is `cleanDocumento`, shared with the cliente `CpfCnpjInput`
 * rather than copied: uppercase, `[^0-9A-Z]` stripped, capped at 14. That
 * uppercasing is load-bearing beyond tidiness — see the canonical-form note on
 * `filialSchema.cnpj`. No `inputMode="numeric"`: the value is not numeric.
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
      description={formatted ?? hint ?? 'CNPJ (14 caracteres — pode conter letras)'}
      value={v}
      onChange={(e) => onChange(cleanDocumento(e.currentTarget.value))}
      onBlur={onBlur}
      error={error}
      disabled={disabled}
    />
  );
}
