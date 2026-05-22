'use client';

import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Checkbox,
  Popover,
  ScrollArea,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';

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
 * Once a table exposes more columns than this, the picker grows a search
 * box — scrolling a 30+ checkbox list to find one column is tedious.
 */
const SEARCH_THRESHOLD = 7;

/**
 * Popover that lists every column (schema-derived + virtual) with a
 * checkbox to toggle visibility. The checkbox list lives inside an
 * autosized ScrollArea so big schemas (pedidos has 30+ fields) don't
 * blow the popover past the viewport and break page scroll. Schemas with
 * more than `SEARCH_THRESHOLD` columns also get a label search box.
 *
 * State is owned by the TableView; this component is presentational
 * apart from the local search query.
 */
export function ColumnPicker({ fields, visibleKeys, onToggle }: ColumnPickerProps) {
  const [query, setQuery] = useState('');
  const showSearch = fields.length > SEARCH_THRESHOLD;

  const visibleFields = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fields;
    return fields.filter((f) => f.label.toLowerCase().includes(q));
  }, [fields, query]);

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
          {showSearch && (
            <TextInput
              size="xs"
              placeholder="Buscar coluna"
              aria-label="Buscar coluna"
              leftSection={<IconSearch size={14} />}
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
          )}
          <ScrollArea.Autosize mah={400} type="auto" offsetScrollbars>
            <Stack gap="xs">
              {visibleFields.length === 0 ? (
                <Text size="xs" c="dimmed">Nenhuma coluna encontrada.</Text>
              ) : (
                visibleFields.map((f) => (
                  <Checkbox
                    key={f.key}
                    label={f.label}
                    checked={visibleKeys.has(f.key)}
                    onChange={() => onToggle(f.key)}
                  />
                ))
              )}
            </Stack>
          </ScrollArea.Autosize>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
