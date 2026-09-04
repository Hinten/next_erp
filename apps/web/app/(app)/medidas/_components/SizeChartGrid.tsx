'use client';

import {
  ActionIcon,
  Group,
  MultiSelect,
  Select,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import { localizarDecimal } from '@delfrance/core/decimal';

import type { ChartCellValue, ChartRowDraft } from '@/lib/mercado-livre/chartRows';
import { cellErrorKey } from '@/lib/mercado-livre/chartRows';
import type { ChartColumn, ChartColumnPart } from '@/lib/mercado-livre/chartSpec';
import { unitLabel } from '@/lib/mercado-livre/units';

/** Width of the frozen first column, shared by the header and body cells. */
const MAIN_COL_WIDTH = 180;

const stickyCell = {
  position: 'sticky' as const,
  left: 0,
  zIndex: 1,
  background: 'var(--mantine-color-body)',
  minWidth: MAIN_COL_WIDTH,
};

export interface SizeChartGridProps {
  columns: ChartColumn[];
  rows: ChartRowDraft[];
  /** Chosen unit per column key. */
  units: Record<string, string | null>;
  /** Messages per `cellErrorKey(rowIndex, attributeId)`. */
  cellErrors: Map<string, string[]>;
  /** The chart's main attribute — its column is frozen once the guia is sent. */
  mainAttributeId: string;
  /** The guia is already on ML: its main attribute and row set are immutable. */
  sent: boolean;
  /** No edits at all (a send is in flight, or the operator lacks write). */
  disabled: boolean;
  onCellChange: (rowIndex: number, attributeId: string, value: ChartCellValue) => void;
  onUnitChange: (columnKey: string, unit: string | null) => void;
  onToggleDelete: (rowIndex: number) => void;
}

/**
 * The measurement grid: one row per size, one column per attribute the domain's
 * ficha técnica declares.
 *
 * Two ML constraints are visible in the markup rather than discovered on send:
 *
 *  - **rows can never be deleted** once ML has seen them, so a row with an id
 *    simply has no delete control (and the tooltip says why);
 *  - **a row's main attribute is immutable**, so the first column locks on a
 *    sent guia while the measurement columns stay editable — which is exactly
 *    the split `PUT /catalog/charts/{id}/rows/{rowId}` supports.
 *
 * Row removal on an unsent guia is STAGED (apps/web CLAUDE.md rule 7): the row
 * dims, says "Será excluída" and keeps an undo until the guia is saved or sent.
 */
export function SizeChartGrid({
  columns,
  rows,
  units,
  cellErrors,
  mainAttributeId,
  sent,
  disabled,
  onCellChange,
  onUnitChange,
  onToggleDelete,
}: SizeChartGridProps) {
  if (columns.length === 0) return null;

  return (
    <Table.ScrollContainer minWidth={Math.max(560, 220 * columns.length)} type="native">
      <Table stickyHeader highlightOnHover withTableBorder data-testid="ml-size-chart-grid">
        <Table.Thead>
          <Table.Tr>
            {columns.map((column, i) => (
              <Table.Th key={column.key} style={i === 0 ? stickyCell : undefined}>
                <Group gap={4} wrap="nowrap" align="center">
                  <Text size="sm" fw={600}>
                    {column.label}
                    {column.required && (
                      <Text span c="red" aria-hidden>
                        {' *'}
                      </Text>
                    )}
                  </Text>
                  {column.hint && (
                    <Tooltip label={column.hint} multiline w={240} withArrow>
                      <Text size="xs" c="dimmed" style={{ cursor: 'help' }}>
                        ?
                      </Text>
                    </Tooltip>
                  )}
                </Group>
                {column.unit.options.length > 1 ? (
                  <Select
                    size="xs"
                    mt={4}
                    aria-label={`Unidade de ${column.label}`}
                    // `unitLabel` spells out ML's inch unit, whose id and name
                    // are both a bare `"` and render as a blank-looking option.
                    data={column.unit.options.map((u) => ({
                      value: u.id,
                      label: unitLabel(u.id),
                    }))}
                    value={units[column.key] ?? column.unit.default}
                    onChange={(v) => {
                      onUnitChange(column.key, v);
                    }}
                    disabled={disabled}
                    allowDeselect={false}
                    comboboxProps={{ withinPortal: true }}
                  />
                ) : (
                  units[column.key] != null && (
                    <Text size="xs" c="dimmed">
                      {unitLabel(units[column.key]!)}
                    </Text>
                  )
                )}
              </Table.Th>
            ))}
            <Table.Th w={56} />
          </Table.Tr>
        </Table.Thead>

        <Table.Tbody>
          {rows.map((row, rowIndex) => (
            <Table.Tr
              key={row.key}
              opacity={row.deleted ? 0.5 : 1}
              data-testid={`ml-size-chart-row-${String(rowIndex)}`}
            >
              {columns.map((column, i) => (
                <Table.Td key={column.key} style={i === 0 ? stickyCell : undefined}>
                  <Group gap={4} wrap="nowrap" align="flex-start">
                    {column.parts.map((part, partIndex) => (
                      <PartInput
                        key={part.attributeId}
                        part={part}
                        connector={partIndex > 0 ? column.connector : null}
                        value={row.cells[part.attributeId]}
                        rowIndex={rowIndex}
                        errors={cellErrors.get(cellErrorKey(rowIndex, part.attributeId))}
                        // The main attribute is what ML keys the row by, and it
                        // cannot be changed once the row exists there.
                        disabled={
                          disabled ||
                          row.deleted ||
                          (sent && part.attributeId === mainAttributeId && row.id != null)
                        }
                        onChange={(v) => {
                          onCellChange(rowIndex, part.attributeId, v);
                        }}
                      />
                    ))}
                  </Group>
                  {i === 0 && row.deleted && (
                    <Text size="xs" c="dimmed" mt={4}>
                      Será excluída
                    </Text>
                  )}
                </Table.Td>
              ))}

              <Table.Td>
                {row.id == null ? (
                  <ActionIcon
                    variant="subtle"
                    color={row.deleted ? 'blue' : 'red'}
                    aria-label={
                      row.deleted
                        ? `Desfazer exclusão da linha ${String(rowIndex + 1)}`
                        : `Excluir linha ${String(rowIndex + 1)}`
                    }
                    disabled={disabled}
                    onClick={() => {
                      onToggleDelete(rowIndex);
                    }}
                  >
                    {row.deleted ? <IconArrowBackUp size={16} /> : <IconTrash size={16} />}
                  </ActionIcon>
                ) : (
                  <Tooltip
                    label="O Mercado Livre não permite excluir linhas de uma guia já enviada."
                    multiline
                    w={220}
                    withArrow
                  >
                    <Text size="xs" c="dimmed" style={{ cursor: 'help' }}>
                      —
                    </Text>
                  </Tooltip>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** One attribute's input. A FROM/TO pair renders two of these with a connector. */
function PartInput({
  part,
  connector,
  value,
  rowIndex,
  errors,
  disabled,
  onChange,
}: {
  part: ChartColumnPart;
  connector: string | null;
  value: ChartCellValue | undefined;
  rowIndex: number;
  errors: string[] | undefined;
  disabled: boolean;
  onChange: (value: ChartCellValue) => void;
}) {
  // ML's messages are full sentences; the legacy screen ellipsised them to one
  // line inside a 125px field, so in practice you saw nothing without hovering.
  const error = errors?.join(' ') ?? null;
  const label = `${part.label} (linha ${String(rowIndex + 1)})`;
  const common = {
    'aria-label': label,
    size: 'xs' as const,
    disabled,
    error,
    'data-testid': `ml-cell-${part.attributeId}-${String(rowIndex)}`,
  };

  const input = (() => {
    if (part.kind === 'select') {
      return (
        <Select
          {...common}
          data={part.values.map((v) => ({ value: v.id, label: v.name }))}
          value={value?.value_id ?? null}
          onChange={(id) => {
            const picked = part.values.find((v) => v.id === id) ?? null;
            onChange({
              value_id: picked?.id ?? null,
              value_name: picked?.name ?? null,
              valueList: null,
            });
          }}
          searchable
          clearable
          comboboxProps={{ withinPortal: true }}
        />
      );
    }
    if (part.kind === 'multiselect') {
      return (
        <MultiSelect
          {...common}
          data={part.values.map((v) => ({ value: v.id, label: v.name }))}
          value={(value?.valueList ?? []).map((v) => v.id)}
          onChange={(ids) => {
            const picked = ids
              .map((id) => part.values.find((v) => v.id === id))
              .filter((v): v is (typeof part.values)[number] => v != null);
            onChange({
              value_id: null,
              value_name: null,
              valueList: picked.length > 0 ? picked : null,
            });
          }}
          searchable
          clearable
          comboboxProps={{ withinPortal: true }}
        />
      );
    }
    // `number` and `text` alike: a plain input, NOT `DecimalInput`. ML stores
    // every measurement as a STRING and echoes it back verbatim on the anúncio,
    // so a widget that parses to `number | null` would erase the difference
    // between `10,5` and `10,50`.
    //
    // The separator IS normalised, to the comma — on change rather than on blur,
    // because "Enviar guia" is reachable straight from a focused field and a
    // blur-only rule would ship the dot the operator never saw corrected. The
    // swap is same-length, so the caret does not move while typing.
    return (
      <TextInput
        {...common}
        inputMode={part.kind === 'number' ? 'decimal' : 'text'}
        value={value?.value_name ?? ''}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          const next = part.kind === 'number' ? localizarDecimal(raw) : raw;
          onChange({ value_id: null, value_name: next === '' ? null : next, valueList: null });
        }}
      />
    );
  })();

  if (connector == null) return <div style={{ flex: 1, minWidth: 96 }}>{input}</div>;
  return (
    <>
      <Text size="xs" c="dimmed" mt={6}>
        {connector}
      </Text>
      <div style={{ flex: 1, minWidth: 96 }}>{input}</div>
    </>
  );
}
