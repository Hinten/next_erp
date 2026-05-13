'use client';

import {
  NumberInput,
  Select,
  Switch,
  TextInput,
  Textarea,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { Controller, type Control, type FieldValues } from 'react-hook-form';
import type { FieldConfig, FieldDescriptor, FieldRenderProps } from '../schema/types';
import { NullClearButton } from './NullClearButton';

export interface FieldRendererProps {
  control: Control<FieldValues>;
  descriptor: FieldDescriptor;
  config?: FieldConfig;
}

/**
 * Renders one form field. RHF `Controller` is the integration point; the
 * descriptor's `kind` decides which Mantine widget renders.
 *
 * Nullable string-shaped fields get a `✕` rightSection that clears the
 * value to literal `null` (not `undefined`) so the patch preserves intent.
 */
export function FieldRenderer({ control, descriptor, config }: FieldRendererProps) {
  const label = config?.label ?? descriptor.label;
  const hint = config?.hint ?? descriptor.hint;
  const editable = config?.editable !== false;

  return (
    <Controller
      control={control}
      name={descriptor.key}
      render={({ field, fieldState }) => {
        // If the consumer supplied a renderInput override, forward the
        // descriptor + field props and let them render anything they want.
        if (config?.renderInput) {
          const props: FieldRenderProps = {
            name: descriptor.key,
            label, hint,
            value: field.value,
            onChange: field.onChange,
            onBlur: field.onBlur,
            disabled: !editable,
            error: fieldState.error?.message,
            descriptor,
          };
          return <>{config.renderInput(props)}</>;
        }

        const error = fieldState.error?.message;
        const kind = config?.kind ?? descriptor.kind;
        const valueString = (field.value as string | null | undefined) ?? '';

        const clearButton =
          descriptor.nullable && (kind === 'string' || kind === 'email' || kind === 'tel' || kind === 'url') ? (
            <NullClearButton onClear={() => field.onChange(null)} />
          ) : null;

        switch (kind) {
          case 'longText':
            return (
              <Textarea
                {...field}
                value={valueString}
                label={label} description={hint} error={error}
                disabled={!editable}
                autosize minRows={2}
              />
            );
          case 'email':
            return (
              <TextInput
                {...field}
                value={valueString}
                label={label} description={hint} error={error}
                disabled={!editable}
                type="email"
                rightSection={clearButton}
              />
            );
          case 'tel':
            return (
              <TextInput
                {...field}
                value={valueString}
                label={label} description={hint} error={error}
                disabled={!editable}
                inputMode="tel"
                rightSection={clearButton}
              />
            );
          case 'url':
            return (
              <TextInput
                {...field}
                value={valueString}
                label={label} description={hint} error={error}
                disabled={!editable}
                type="url"
                rightSection={clearButton}
              />
            );
          case 'number':
            return (
              <NumberInput
                value={field.value as number | string | undefined ?? ''}
                onChange={(v) => field.onChange(typeof v === 'string' ? Number(v) : v)}
                onBlur={field.onBlur}
                label={label} description={hint} error={error}
                disabled={!editable}
              />
            );
          case 'integer':
            return (
              <NumberInput
                value={field.value as number | string | undefined ?? ''}
                onChange={(v) => field.onChange(typeof v === 'string' ? Number(v) : v)}
                onBlur={field.onBlur}
                label={label} description={hint} error={error}
                disabled={!editable}
                allowDecimal={false}
              />
            );
          case 'currency':
            return (
              <NumberInput
                value={field.value as number | string | undefined ?? ''}
                onChange={(v) => field.onChange(typeof v === 'string' ? Number(v) : v)}
                onBlur={field.onBlur}
                label={label} description={hint ?? 'Valor em centavos (BRL).'}
                error={error}
                disabled={!editable}
                allowDecimal={false}
              />
            );
          case 'boolean':
            return (
              <Switch
                checked={!!field.value}
                onChange={(e) => field.onChange(e.currentTarget.checked)}
                onBlur={field.onBlur}
                label={label} description={hint}
                disabled={!editable}
              />
            );
          case 'enum': {
            const data = config?.options ?? descriptor.enumValues ?? [];
            return (
              <Select
                label={label} description={hint} error={error}
                disabled={!editable}
                data={data}
                value={(field.value as string | null | undefined) ?? null}
                onChange={(v) => field.onChange(v)}
                onBlur={field.onBlur}
                clearable={descriptor.nullable || descriptor.optional}
              />
            );
          }
          case 'date': {
            // Mantine 9's DatePickerInput speaks YYYY-MM-DD strings; our
            // wire format is full ISO datetimes. Round-trip via Date so we
            // preserve any time component the caller stored.
            const value = field.value as string | Date | null | undefined;
            const dateStr =
              typeof value === 'string'
                ? value.slice(0, 10)
                : value && typeof (value as { getTime?: () => number }).getTime === 'function'
                  ? (value as Date).toISOString().slice(0, 10)
                  : null;
            return (
              <DatePickerInput
                label={label} description={hint} error={error}
                disabled={!editable}
                value={dateStr}
                onChange={(v) => {
                  // v is `string | null` (YYYY-MM-DD). Promote to full ISO
                  // to keep wire format stable.
                  field.onChange(v ? new Date(`${v}T00:00:00.000Z`).toISOString() : v);
                }}
              />
            );
          }
          case 'reference':
            // Minimal: show an editable string (the doc id/path). A real
            // async-select reference picker is a follow-up — out of scope
            // until we have a concrete reference field in production.
            return (
              <TextInput
                {...field}
                value={valueString}
                label={label}
                description={hint ?? (descriptor.referenceCollection ? `Ref → ${descriptor.referenceCollection}` : undefined)}
                error={error}
                disabled={!editable}
                rightSection={clearButton}
              />
            );
          case 'string':
          default:
            return (
              <TextInput
                {...field}
                value={valueString}
                label={label} description={hint} error={error}
                disabled={!editable}
                rightSection={clearButton}
              />
            );
        }
      }}
    />
  );
}
