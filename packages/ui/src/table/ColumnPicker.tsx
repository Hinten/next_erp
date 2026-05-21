'use client';

import { ActionIcon, Checkbox, Popover, Stack, Text } from '@mantine/core';

/**
 * Minimum shape the picker needs — just an identifier + display label.
 * `FieldDescriptor` and `VirtualColumn` both structurally satisfy this,
 * so TableView passes either or both.
 */
export interface ColumnPickerItem {
  readonly key: string;
  readonly label: string;
}

export interface ColumnPickerProps {
  fields: ReadonlyArray<ColumnPickerItem>;
  visibleKeys: Set<string>;
  onToggle: (key: string) => void;
}

/**
 * Popover that lists every column (schema-derived + virtual) with a
 * checkbox to toggle visibility. State is owned by the TableView; this
 * component is presentational.
 */
export function ColumnPicker({ fields, visibleKeys, onToggle }: ColumnPickerProps) {
  return (
    <Popover position="bottom-end" width={260} shadow="md">
      <Popover.Target>
        <ActionIcon variant="default" aria-label="Configurar colunas">
          ⚙
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="sm" fw={500}>Colunas visíveis</Text>
          {fields.map((f) => (
            <Checkbox
              key={f.key}
              label={f.label}
              checked={visibleKeys.has(f.key)}
              onChange={() => onToggle(f.key)}
            />
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
