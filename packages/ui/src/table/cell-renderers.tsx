import type { ReactNode } from 'react';
import { Badge, Text } from '@mantine/core';
import { format, money } from '@delfrance/core/money';
import type { FieldDescriptor } from '../schema/types';

const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
});

/**
 * Default cell renderer keyed off `FieldKind`. Consumers can override per
 * field via `FieldConfig.renderCell` — this only kicks in when no override
 * is supplied.
 *
 * Renders an em-dash for null/undefined so the table reads cleanly when the
 * field is nullable.
 */
export function renderCell(value: unknown, descriptor: FieldDescriptor): ReactNode {
  if (value === null || value === undefined || value === '') {
    return <Text c="dimmed">—</Text>;
  }

  switch (descriptor.kind) {
    case 'currency':
      // Stored as integer minor units. Default to BRL — multi-currency is a
      // later iteration that can override via FieldConfig.renderCell.
      if (typeof value === 'number') return format(money(value, 'BRL'));
      return String(value);
    case 'boolean':
      return value ? '✓' : '—';
    case 'enum': {
      const match = descriptor.enumValues?.find((e) => e.value === String(value));
      return <Badge variant="light">{match?.label ?? String(value)}</Badge>;
    }
    case 'date': {
      const str = typeof value === 'string' || value instanceof Date ? value : null;
      if (!str) return String(value);
      const date = typeof str === 'string' ? new Date(str) : str;
      if (Number.isNaN(date.getTime())) return String(value);
      return dateFormatter.format(date);
    }
    case 'number':
    case 'integer':
      return typeof value === 'number' ? value.toLocaleString('pt-BR') : String(value);
    case 'array':
      return Array.isArray(value) ? `${value.length} item(s)` : String(value);
    case 'object':
      return <Text c="dimmed">…</Text>;
    case 'unknown':
      return <Text c="dimmed">—</Text>;
    default:
      return String(value);
  }
}
