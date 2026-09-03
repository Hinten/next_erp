'use client';

import { type ReactNode, useState } from 'react';
import { ActionIcon, Button, Group, Popover, Select, Stack, TextInput } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { IconFilter, IconFilterFilled } from '@tabler/icons-react';
import type { PipelineFilterOp } from '@delfrance/data';
import type { ColumnFilterValue, FilterableField } from '../schema/types';
import { type EpochUnit, epochToPickerString, pickerStringToEpoch } from '../object/datetimeField';
import { DecimalInput } from '../inputs/DecimalInput';

// `ColumnFilterValue` now lives in ../schema/types (so `VirtualColumn.filter`
// can reference it without a circular import). Re-exported here for the
// existing call sites that import it from this module.
export type { ColumnFilterValue } from '../schema/types';

export interface ColumnFilterProps {
  /** Only the subset the filter UI reads — a full FieldDescriptor satisfies it. */
  descriptor: FilterableField;
  value: ColumnFilterValue | undefined;
  onChange: (next: ColumnFilterValue | undefined) => void;
}

export interface FilterPopoverProps {
  /** Renders the icon filled/highlighted when a filter is set. */
  active: boolean;
  /** Used for the trigger's aria-label (`Filtrar <label>`). */
  label: string;
  /** Popover body; receives a `close` callback to dismiss after apply/clear. */
  children: (close: () => void) => ReactNode;
}

/**
 * The filter-icon trigger + Popover shell shared by the schema-column
 * {@link ColumnFilter} and a virtual column's custom `renderFilter` body.
 */
export function FilterPopover({ active, label, children }: FilterPopoverProps) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" shadow="md" withArrow>
      <Popover.Target>
        <ActionIcon
          variant={active ? 'filled' : 'subtle'}
          color={active ? 'blue' : 'gray'}
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setOpened((o) => !o);
          }}
          aria-label={`Filtrar ${label}`}
        >
          {active ? <IconFilterFilled size={14} /> : <IconFilter size={14} />}
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>{children(() => setOpened(false))}</Popover.Dropdown>
    </Popover>
  );
}

/**
 * Per-column filter popover. Renders an input appropriate for the field kind
 * and writes a `ColumnFilterValue` upstream. Clearing the input (or hitting
 * "Limpar") emits `undefined` so the TableView drops the filter entirely.
 *
 * Supported kinds:
 *  - string / longText / email / tel / url  →  TextInput (contains, regex
 *    similarity — case- and accent-insensitive substring match)
 *  - enum                                    →  Select (eq)
 *  - boolean                                 →  Select Sim/Não (eq)
 *  - number / integer / currency             →  DecimalInput + op picker
 *  - datetime                                →  DateTimePicker + ≥/≤ op
 *    (numeric-epoch fields; the exact chosen instant is converted to the
 *    field's `dateUnit` via `pickerStringToEpoch`)
 *
 * Text/number inputs submit on Enter.
 *
 * Other kinds (date, reference, array, object, unknown) render no affordance.
 */
export function ColumnFilter({ descriptor, value, onChange }: ColumnFilterProps) {
  if (!isFilterable(descriptor)) return null;

  return (
    <FilterPopover active={value !== undefined} label={descriptor.label}>
      {(close) => (
        <FilterBody
          descriptor={descriptor}
          value={value}
          onApply={(next) => {
            onChange(next);
            close();
          }}
          onClear={() => {
            onChange(undefined);
            close();
          }}
        />
      )}
    </FilterPopover>
  );
}

function isFilterable(d: FilterableField): boolean {
  return (
    d.kind === 'string' ||
    d.kind === 'longText' ||
    d.kind === 'email' ||
    d.kind === 'tel' ||
    d.kind === 'url' ||
    d.kind === 'enum' ||
    d.kind === 'boolean' ||
    d.kind === 'number' ||
    d.kind === 'integer' ||
    d.kind === 'currency' ||
    // Numeric-epoch fields only (`microsSinceEpoch`/`millisSinceEpoch`). The
    // string-ISO `date` kind has no numeric ordering here, so it stays inert.
    d.kind === 'datetime'
  );
}

interface FilterBodyProps {
  descriptor: FilterableField;
  value: ColumnFilterValue | undefined;
  onApply: (next: ColumnFilterValue) => void;
  onClear: () => void;
}

function FilterBody({ descriptor, value, onApply, onClear }: FilterBodyProps) {
  const { kind } = descriptor;

  if (kind === 'enum') {
    const data = descriptor.enumValues ?? [];
    return (
      <FilterShell onClear={onClear}>
        <Select
          label={descriptor.label}
          data={data}
          value={(value?.value as string | null) ?? null}
          onChange={(v) => v !== null && onApply({ op: 'eq', value: v })}
          searchable
          clearable
          comboboxProps={{ withinPortal: false }}
        />
      </FilterShell>
    );
  }

  if (kind === 'boolean') {
    return (
      <FilterShell onClear={onClear}>
        <Select
          label={descriptor.label}
          data={[
            { value: 'true', label: 'Sim' },
            { value: 'false', label: 'Não' },
          ]}
          value={value === undefined ? null : value.value ? 'true' : 'false'}
          onChange={(v) => v !== null && onApply({ op: 'eq', value: v === 'true' })}
          clearable
          comboboxProps={{ withinPortal: false }}
        />
      </FilterShell>
    );
  }

  if (kind === 'number' || kind === 'integer' || kind === 'currency') {
    return (
      <NumericBody descriptor={descriptor} value={value} onApply={onApply} onClear={onClear} />
    );
  }

  if (kind === 'datetime') {
    return <DateBody descriptor={descriptor} value={value} onApply={onApply} onClear={onClear} />;
  }

  // string-ish: TextInput → contains (regex similarity)
  return <TextBody descriptor={descriptor} value={value} onApply={onApply} onClear={onClear} />;
}

function TextBody({ descriptor, value, onApply, onClear }: FilterBodyProps) {
  const [local, setLocal] = useState((value?.value as string) ?? '');
  const apply = () => onApply({ op: 'contains', value: local.trim() });
  const disabled = local.trim() === '';
  return (
    <FilterShell
      onClear={() => {
        setLocal('');
        onClear();
      }}
      onApply={apply}
      applyDisabled={disabled}
    >
      <TextInput
        label={`${descriptor.label} contém`}
        value={local}
        onChange={(e) => setLocal(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !disabled) {
            e.preventDefault();
            apply();
          }
        }}
        autoFocus
      />
    </FilterShell>
  );
}

function NumericBody({ descriptor, value, onApply, onClear }: FilterBodyProps) {
  const [op, setOp] = useState<PipelineFilterOp>(value?.op ?? 'eq');
  const [local, setLocal] = useState<number | null>((value?.value as number) ?? null);
  const disabled = local === null;
  const apply = () => {
    if (local !== null) onApply({ op, value: local });
  };
  return (
    <FilterShell
      onClear={() => {
        setLocal(null);
        onClear();
      }}
      onApply={apply}
      applyDisabled={disabled}
    >
      <Stack gap="xs">
        <Select
          label="Operador"
          data={[
            { value: 'eq', label: '=' },
            { value: 'lt', label: '<' },
            { value: 'lte', label: '≤' },
            { value: 'gt', label: '>' },
            { value: 'gte', label: '≥' },
          ]}
          value={op}
          onChange={(v) => v && setOp(v as PipelineFilterOp)}
          // Render inline: a portaled dropdown's option click reads as a
          // click-outside and closes the surrounding FilterPopover.
          comboboxProps={{ withinPortal: false }}
        />
        <DecimalInput
          label={descriptor.label}
          value={local}
          onChange={setLocal}
          allowNegative
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !disabled) {
              e.preventDefault();
              apply();
            }
          }}
        />
      </Stack>
    </FilterShell>
  );
}

/**
 * Date+time filter for numeric-epoch (`kind: 'datetime'`) columns. A datetime +
 * operator (≥ "a partir de" / ≤ "até") maps to a numeric bound in the field's
 * `dateUnit` via `pickerStringToEpoch` — the same epoch⇄picker conversion the
 * ObjectView's datetime field uses. The bound is the exact chosen instant. The
 * Pipeline already supports numeric `gte`/`lte`, so this needs no data-layer
 * change.
 */
function DateBody({ descriptor, value, onApply, onClear }: FilterBodyProps) {
  const unit: EpochUnit = descriptor.dateUnit ?? 'us';
  const [op, setOp] = useState<PipelineFilterOp>(value?.op === 'lte' ? 'lte' : 'gte');
  const initial =
    value && typeof value.value === 'number' ? epochToPickerString(value.value, unit) : null;
  // Full picker string: 'YYYY-MM-DD HH:mm:ss' (local wall-clock).
  const [dt, setDt] = useState<string | null>(initial);
  const disabled = !dt;
  const apply = () => {
    const micros = pickerStringToEpoch(dt, unit);
    if (micros == null) return;
    onApply({ op, value: micros });
  };
  return (
    <FilterShell
      onClear={() => {
        setDt(null);
        onClear();
      }}
      onApply={apply}
      applyDisabled={disabled}
    >
      <Stack gap="xs">
        <Select
          label="Operador"
          data={[
            { value: 'gte', label: 'A partir de (≥)' },
            { value: 'lte', label: 'Até (≤)' },
          ]}
          value={op}
          onChange={(v) => v && setOp(v as PipelineFilterOp)}
          // Render inline (see NumericBody): keep the FilterPopover open.
          comboboxProps={{ withinPortal: false }}
        />
        <DateTimePicker
          label={descriptor.label}
          value={dt}
          onChange={setDt}
          valueFormat="DD/MM/YYYY HH:mm"
          clearable
          // Render inline (see the operator Select): a portaled calendar/time
          // click would read as a click-outside and close the FilterPopover.
          popoverProps={{ withinPortal: false }}
        />
      </Stack>
    </FilterShell>
  );
}

interface ShellProps {
  children: React.ReactNode;
  onApply?: () => void;
  onClear: () => void;
  applyDisabled?: boolean;
}

function FilterShell({ children, onApply, onClear, applyDisabled }: ShellProps) {
  return (
    <Stack gap="xs" miw={220}>
      {children}
      <Group justify="flex-end" gap="xs">
        <Button size="xs" variant="subtle" onClick={onClear}>
          Limpar
        </Button>
        {onApply && (
          <Button size="xs" onClick={onApply} disabled={applyDisabled}>
            Aplicar
          </Button>
        )}
      </Group>
    </Stack>
  );
}
