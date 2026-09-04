'use client';

import { TextInput } from '@mantine/core';
import { normalizeTelefone } from '@delfrance/core/phone';
import type { FieldRenderProps } from '@delfrance/ui';

const DEFAULT_HINT = 'Com DDD — salvo com o código do país (55…)';

export interface TelefoneTextInputProps {
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
 * Phone input for the standardized wire format (digits-only E.164 without
 * '+', WhatsApp wa_id compatible). Typing is restricted to digits; when the
 * normalized value differs from what was typed, the description previews
 * what will be persisted. The value itself is NEVER mutated here — blurring
 * through a legacy doc must not dirty it; normalization happens at save
 * time (`prepareForSaveTelefone`) or at submit in custom forms.
 */
export function TelefoneTextInput({
  value,
  onChange,
  onBlur,
  label,
  description,
  error,
  disabled,
  required,
}: TelefoneTextInputProps) {
  const normalized = value === '' ? '' : normalizeTelefone(value);
  const preview =
    normalized !== '' && normalized !== value ? `Será salvo como ${normalized}` : null;
  return (
    <TextInput
      label={label}
      description={preview ?? description ?? DEFAULT_HINT}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value.replace(/\D/g, ''))}
      onBlur={onBlur}
      error={error}
      maxLength={16}
      inputMode="numeric"
      disabled={disabled}
      required={required}
    />
  );
}

/** ObjectView `renderInput` adapter. */
export function TelefoneField({
  value,
  onChange,
  onBlur,
  error,
  label,
  hint,
  disabled,
}: FieldRenderProps) {
  return (
    <TelefoneTextInput
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

/**
 * `FieldConfig.prepareForSave` for telefone fields: normalizes non-empty
 * strings to the standardized wire format. ObjectView applies this before
 * validation (resolver) and, at save time, to all fields on create but only
 * to DIRTY fields on update — so untouched legacy raw phones are validated
 * leniently and never silently rewritten.
 *
 * ⚠️ On a NESTED field (`enderecoDeOrigem.telefone`) the gate is the PARENT's
 * dirty flag, so editing any sub-field of that address normalizes the phone
 * too. That is not an over-reach: Firestore replaces a nested object
 * wholesale, so the phone is being rewritten by that save either way.
 */
export const prepareForSaveTelefone = (v: unknown): unknown =>
  typeof v === 'string' && v !== '' ? normalizeTelefone(v) : v;
