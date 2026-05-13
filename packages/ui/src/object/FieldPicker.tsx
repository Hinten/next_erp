'use client';

import { Button, Checkbox, Popover, Stack, Text } from '@mantine/core';
import type { FieldDescriptor } from '../schema/types';

export interface FieldPickerProps {
  fields: FieldDescriptor[];
  visibleKeys: Set<string>;
  onToggle: (key: string) => void;
}

/**
 * ObjectView counterpart to TableView's ColumnPicker. Hide/show fields
 * inside the current section without round-tripping through the schema or
 * a persisted preference (state is local to the ObjectView).
 */
export function FieldPicker({ fields, visibleKeys, onToggle }: FieldPickerProps) {
  return (
    <Popover position="bottom-end" width={280} shadow="md">
      <Popover.Target>
        <Button variant="default" size="xs">Campos</Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="sm" fw={500}>Campos visíveis</Text>
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
