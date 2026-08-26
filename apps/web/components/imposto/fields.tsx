'use client';

import { Select, SimpleGrid } from '@mantine/core';
import { DecimalInput } from '@delfrance/ui';

export interface NumberFieldProps {
  label: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  description?: string;
  error?: string;
}

/** A non-negative numeric input for a fiscal value/rate/quantity (`null` when empty). */
export function NumberField({
  label,
  value,
  onChange,
  disabled,
  description,
  error,
}: NumberFieldProps) {
  return (
    <DecimalInput
      label={label}
      description={description}
      error={error}
      value={value ?? null}
      onChange={onChange}
      decimalScale={6}
      step={0.01}
      hideControls
      disabled={disabled}
    />
  );
}

export interface EnumSelectProps {
  label: string;
  labels: Record<string, string>;
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  disabled?: boolean;
  description?: string;
  error?: string;
  clearable?: boolean;
  required?: boolean;
}

/** A Select whose options come from a `{ code: label }` map. */
export function EnumSelect({
  label,
  labels,
  value,
  onChange,
  disabled,
  description,
  error,
  clearable = true,
  required,
}: EnumSelectProps) {
  const data = Object.entries(labels).map(([value, label]) => ({ value, label }));
  return (
    <Select
      label={label}
      description={description}
      error={error}
      data={data}
      value={value ?? null}
      onChange={onChange}
      clearable={clearable}
      searchable
      withAsterisk={required}
      disabled={disabled}
      comboboxProps={{ withinPortal: true }}
    />
  );
}

/** One field of a nested tribute sub-config (e.g. `confICMSSN201`). */
export type FieldSpec =
  | { key: string; label: string; kind: 'money' | 'rate' | 'qty' }
  | { key: string; label: string; kind: 'select'; labels: Record<string, string> };

const UNIT_SUFFIX: Record<'money' | 'rate' | 'qty', string> = {
  money: ' (R$)',
  rate: ' (%)',
  qty: '',
};

export interface SubConfigGridProps {
  /** The current nested sub-config object (e.g. `value.configuracaoICMS.csosn201`). */
  config: Record<string, unknown> | null | undefined;
  specs: ReadonlyArray<FieldSpec>;
  /** Merge `patch` into the sub-config (replacing it when every field clears). */
  onPatch: (patch: Record<string, unknown>) => void;
  disabled?: boolean;
  /** RHF error node for this sub-config (keyed by field), if any. */
  errorNode?: Record<string, { message?: string } | undefined>;
}

/** Renders a grid of inputs for a flat tribute sub-config from its field specs. */
export function SubConfigGrid({ config, specs, onPatch, disabled, errorNode }: SubConfigGridProps) {
  const cfg = (config ?? {}) as Record<string, unknown>;
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
      {specs.map((spec) => {
        const err = errorNode?.[spec.key]?.message;
        if (spec.kind === 'select') {
          return (
            <EnumSelect
              key={spec.key}
              label={spec.label}
              labels={spec.labels}
              value={(cfg[spec.key] as string | null) ?? null}
              onChange={(v) => onPatch({ [spec.key]: v })}
              disabled={disabled}
              error={err}
            />
          );
        }
        return (
          <NumberField
            key={spec.key}
            label={spec.label + UNIT_SUFFIX[spec.kind]}
            value={(cfg[spec.key] as number | null) ?? null}
            onChange={(v) => onPatch({ [spec.key]: v })}
            disabled={disabled}
            error={err}
          />
        );
      })}
    </SimpleGrid>
  );
}
