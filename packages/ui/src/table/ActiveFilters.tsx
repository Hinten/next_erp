'use client';

import { ActionIcon, Badge, Button, Group } from '@mantine/core';
import { IconFilterOff, IconX } from '@tabler/icons-react';
import type { FilterChip } from './describeFilter';

export interface ActiveFiltersProps {
  chips: FilterChip[];
  /** Drop one constraint. */
  onRemove: (key: string) => void;
  /** Drop every constraint at once, search term included. */
  onClearAll: () => void;
}

/**
 * The "this list is filtered" row, sitting between the toolbar and the table.
 *
 * It exists because the list state is now STICKY: a screen reopens in whatever
 * filter it was last left in — from the sidebar, after a reload, and on the way
 * back from a record. Without this row the only evidence would be a filled icon
 * inside a column header, which is fine right after you click it and invisible
 * a day later, when the operator instead concludes the catalogue is empty.
 *
 * ⚠️ Each chip's phrase is rendered as ONE text node on purpose. `clickColumnSort`
 * in the e2e helpers is `getByText(columnLabel, { exact: true })` under
 * Playwright strict mode — splitting the column label into its own element
 * makes that locator resolve to two nodes and reds every sort spec. Nothing
 * here may render a bare column label.
 */
export function ActiveFilters({ chips, onRemove, onClearAll }: ActiveFiltersProps) {
  if (chips.length === 0) return null;
  return (
    <Group gap="xs" wrap="wrap" aria-label="Filtros ativos">
      {chips.map((chip) => (
        <Badge
          key={chip.key}
          variant="light"
          size="lg"
          tt="none"
          rightSection={
            <ActionIcon
              size="xs"
              variant="transparent"
              color="gray"
              aria-label={`Remover filtro ${chip.text}`}
              onClick={() => onRemove(chip.key)}
            >
              <IconX size={12} />
            </ActionIcon>
          }
        >
          {chip.text}
        </Badge>
      ))}
      <Button
        size="compact-xs"
        variant="subtle"
        leftSection={<IconFilterOff size={14} />}
        onClick={onClearAll}
      >
        Limpar filtros
      </Button>
    </Group>
  );
}
