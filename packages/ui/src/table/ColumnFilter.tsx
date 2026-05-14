'use client';

import { useState } from 'react';
import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Popover,
  Select,
  Stack,
  TextInput,
} from '@mantine/core';
import { IconFilter, IconFilterFilled } from '@tabler/icons-react';
import type { PipelineFilterOp } from '@delfrance/data';
import type { FieldDescriptor } from '../schema/types';

export interface ColumnFilterValue {
  op: PipelineFilterOp;
  value: string | number | boolean | null;
}

export interface ColumnFilterProps {
  descriptor: FieldDescriptor;
  value: ColumnFilterValue | undefined;
  onChange: (next: ColumnFilterValue | undefined) => void;
}

/**
 * Per-column filter popover. Renders an input appropriate for the field kind
 * and writes a `ColumnFilterValue` upstream. Clearing the input (or hitting
 * "Limpar") emits `undefined` so the TableView drops the filter entirely.
 *
 * Supported kinds:
 *  - string / longText / email / tel / url  →  TextInput (startsWith)
 *  - enum                                    →  Select (eq)
 *  - boolean                                 →  Select Sim/Não (eq)
 *  - number / integer / currency             →  NumberInput + op picker
 *
 * Other kinds (date, reference, array, object, unknown) render no affordance.
 */
export function ColumnFilter({ descriptor, value, onChange }: ColumnFilterProps) {
  const [opened, setOpened] = useState(false);
  const supported = isFilterable(descriptor);
  if (!supported) return null;

  const active = value !== undefined;

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      shadow="md"
      withArrow
    >
      <Popover.Target>
        <ActionIcon
          variant={active ? 'filled' : 'subtle'}
          color={active ? 'blue' : 'gray'}
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setOpened((o) => !o);
          }}
          aria-label={`Filtrar ${descriptor.label}`}
        >
          {active ? <IconFilterFilled size={14} /> : <IconFilter size={14} />}
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <FilterBody
          descriptor={descriptor}
          value={value}
          onApply={(next) => {
            onChange(next);
            setOpened(false);
          }}
          onClear={() => {
            onChange(undefined);
            setOpened(false);
          }}
        />
      </Popover.Dropdown>
    </Popover>
  );
}

function isFilterable(d: FieldDescriptor): boolean {
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
    d.kind === 'currency'
  );
}

interface FilterBodyProps {
  descriptor: FieldDescriptor;
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
        />
      </FilterShell>
    );
  }

  if (kind === 'number' || kind === 'integer' || kind === 'currency') {
    return (
      <NumericBody descriptor={descriptor} value={value} onApply={onApply} onClear={onClear} />
    );
  }

  // string-ish: TextInput → startsWith
  return (
    <TextBody descriptor={descriptor} value={value} onApply={onApply} onClear={onClear} />
  );
}

function TextBody({ descriptor, value, onApply, onClear }: FilterBodyProps) {
  const [local, setLocal] = useState((value?.value as string) ?? '');
  return (
    <FilterShell
      onClear={() => {
        setLocal('');
        onClear();
      }}
      onApply={() => onApply({ op: 'startsWith', value: local.trim() })}
      applyDisabled={local.trim() === ''}
    >
      <TextInput
        label={`${descriptor.label} começa com`}
        value={local}
        onChange={(e) => setLocal(e.currentTarget.value)}
        autoFocus
      />
    </FilterShell>
  );
}

function NumericBody({ descriptor, value, onApply, onClear }: FilterBodyProps) {
  const [op, setOp] = useState<PipelineFilterOp>(value?.op ?? 'eq');
  const [local, setLocal] = useState<number | ''>((value?.value as number) ?? '');
  return (
    <FilterShell
      onClear={() => {
        setLocal('');
        onClear();
      }}
      onApply={() => typeof local === 'number' && onApply({ op, value: local })}
      applyDisabled={typeof local !== 'number'}
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
        />
        <NumberInput
          label={descriptor.label}
          value={local}
          onChange={(v) => setLocal(typeof v === 'number' ? v : '')}
          autoFocus
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
