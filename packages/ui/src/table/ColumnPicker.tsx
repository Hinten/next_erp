'use client';

import { ActionIcon, Checkbox, Popover, Stack, Text } from '@mantine/core';
import type { FieldDescriptor } from '../schema/types';

export interface ColumnPickerProps {
  fields: FieldDescriptor[];
  visibleKeys: Set<string>;
  onToggle: (key: string) => void;
}

/**
 * Popover that lists every descriptor (excluding `unknown` kind) with a
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
