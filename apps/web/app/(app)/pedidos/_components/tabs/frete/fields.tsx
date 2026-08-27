'use client';

import { Controller, type FieldPath, type UseFormReturn } from 'react-hook-form';
import { Switch, TextInput } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { epochToPickerString, pickerStringToEpoch, DecimalInput } from '@delfrance/ui';
import type { Pedido } from '@delfrance/schemas';
import type { FreteInicialFormState, PedidoFormState } from '../../types';

export type PedidoFormHandle = UseFormReturn<PedidoFormState, unknown, Pedido>;

type KeysWhere<T> = {
  [K in keyof FreteInicialFormState]: FreteInicialFormState[K] extends T ? K : never;
}[keyof FreteInicialFormState];

export type FreteNumberKey = KeysWhere<number | null>;
export type FreteStringKey = KeysWhere<string | null>;
export type FreteBooleanKey = KeysWhere<boolean | null>;

export function fretePath(key: keyof FreteInicialFormState): FieldPath<PedidoFormState> {
  return `freteInicial.${key}` as FieldPath<PedidoFormState>;
}

interface BaseFieldProps {
  form: PedidoFormHandle;
  label: string;
  description?: string;
  disabled?: boolean;
}

/** Two-decimal money/quantity input; empty clears to null. */
export function FreteNumberField({
  form,
  name,
  label,
  description,
  disabled,
  decimalScale = 2,
}: BaseFieldProps & { name: FreteNumberKey; decimalScale?: number }) {
  return (
    <Controller
      control={form.control}
      name={fretePath(name)}
      render={({ field, fieldState }) => (
        <DecimalInput
          label={label}
          description={description}
          value={(field.value as number | null) ?? null}
          onChange={field.onChange}
          onBlur={field.onBlur}
          min={0}
          decimalScale={decimalScale}
          allowDecimal={decimalScale > 0}
          disabled={disabled}
          error={fieldState.error?.message}
        />
      )}
    />
  );
}

export function FreteTextField({
  form,
  name,
  label,
  description,
  disabled,
  maxLength,
}: BaseFieldProps & { name: FreteStringKey; maxLength?: number }) {
  return (
    <Controller
      control={form.control}
      name={fretePath(name)}
      render={({ field, fieldState }) => (
        <TextInput
          label={label}
          description={description}
          value={(field.value as string | null) ?? ''}
          onChange={(e) => field.onChange(e.currentTarget.value || null)}
          onBlur={field.onBlur}
          maxLength={maxLength}
          disabled={disabled}
          error={fieldState.error?.message}
        />
      )}
    />
  );
}

/**
 * Boolean switch. Nullable booleans (`maoPropria`/`avisoRecebimento`) render
 * null as off; the value only becomes a concrete boolean when toggled — an
 * untouched field keeps whatever the doc stored.
 */
export function FreteSwitchField({
  form,
  name,
  label,
  description,
  disabled,
}: BaseFieldProps & { name: FreteBooleanKey }) {
  return (
    <Controller
      control={form.control}
      name={fretePath(name)}
      render={({ field }) => (
        <Switch
          label={label}
          description={description}
          checked={!!field.value}
          onChange={(e) => field.onChange(e.currentTarget.checked)}
          onBlur={field.onBlur}
          disabled={disabled}
        />
      )}
    />
  );
}

/**
 * Wire format is microseconds since epoch (`microsSinceEpoch()`); Mantine 9's
 * DateTimePicker speaks `YYYY-MM-DD HH:mm:ss` strings in the user's local
 * timezone — same wall clock the legacy Flutter client showed. Conversion is
 * shared with the generic `FieldRenderer` via `@delfrance/ui`.
 */
export function FreteDateTimeField({
  form,
  name,
  label,
  description,
  disabled,
}: BaseFieldProps & { name: FreteNumberKey }) {
  return (
    <Controller
      control={form.control}
      name={fretePath(name)}
      render={({ field, fieldState }) => (
        <DateTimePicker
          label={label}
          description={description}
          value={epochToPickerString(field.value as number | null, 'us')}
          onChange={(v) => field.onChange(pickerStringToEpoch(v, 'us'))}
          onBlur={field.onBlur}
          valueFormat="DD/MM/YYYY HH:mm"
          clearable
          disabled={disabled}
          error={fieldState.error?.message}
        />
      )}
    />
  );
}
