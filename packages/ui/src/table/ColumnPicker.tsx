'use client';

import { type CSSProperties, useMemo, useState } from 'react';
import {
  ActionIcon,
  Checkbox,
  Group,
  Popover,
  ScrollArea,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import {
  IconArrowLeft,
  IconArrowsMoveVertical,
  IconChevronDown,
  IconChevronUp,
  IconGripVertical,
  IconSearch,
} from '@tabler/icons-react';
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

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
  /** Visible columns in display order — the source for the reorder list. */
  order: string[];
  /** Persist a new column order (visible keys only, reordered). */
  onReorder: (next: string[]) => void;
}

/**
 * Once a table exposes more columns than this, the picker grows a search
 * box — scrolling a 30+ checkbox list to find one column is tedious.
 */
const SEARCH_THRESHOLD = 7;

/**
 * Popover with two modes. **Visibility** mode lists every column
 * (schema-derived + virtual) with a checkbox to toggle visibility — plus a
 * label search box for wide schemas (> `SEARCH_THRESHOLD` columns). The
 * header's icon button switches to **reorder** mode, which shows only the
 * currently visible columns as a sortable list (drag handle + ▲▼ buttons)
 * so the user can set the display order.
 *
 * Both the checkbox list and the sortable list live inside an autosized
 * ScrollArea so big schemas (pedidos has 30+ fields) don't blow the popover
 * past the viewport. State (visibility + order) is owned by the TableView;
 * this component is presentational apart from the local search query and
 * the visibility/reorder mode toggle.
 */
export function ColumnPicker({
  fields,
  visibleKeys,
  onToggle,
  order,
  onReorder,
}: ColumnPickerProps) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'visibility' | 'reorder'>('visibility');
  const showSearch = fields.length > SEARCH_THRESHOLD;

  const visibleFields = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fields;
    return fields.filter((f) => f.label.toLowerCase().includes(q));
  }, [fields, query]);

  // Reorder-mode list: the visible keys in their stored order, resolved to
  // labels. Keys with no matching field — stale entries left behind by a
  // removed schema column — are dropped.
  const labelByKey = useMemo(
    () => new Map(fields.map((f) => [f.key, f.label])),
    [fields],
  );
  const reorderItems = useMemo(
    () => order.filter((k) => labelByKey.has(k)),
    [order, labelByKey],
  );
  const canReorder = reorderItems.length > 1;

  const sensors = useSensors(
    // A small activation distance so a tap on a row's ▲▼ button is never
    // mistaken for the start of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = reorderItems.indexOf(String(active.id));
    const to = reorderItems.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(reorderItems, from, to));
  }

  return (
    <Popover position="bottom-end" width={260} shadow="md">
      <Popover.Target>
        <ActionIcon variant="default" aria-label="Configurar colunas">
          ⚙
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Text size="sm" fw={500}>
              {mode === 'reorder' ? 'Reordenar colunas' : 'Colunas visíveis'}
            </Text>
            {mode === 'reorder' ? (
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Voltar"
                onClick={() => setMode('visibility')}
              >
                <IconArrowLeft size={16} />
              </ActionIcon>
            ) : (
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Reordenar colunas"
                disabled={!canReorder}
                onClick={() => setMode('reorder')}
              >
                <IconArrowsMoveVertical size={16} />
              </ActionIcon>
            )}
          </Group>

          {mode === 'visibility' ? (
            <>
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
            </>
          ) : (
            <ScrollArea.Autosize mah={400} type="auto" offsetScrollbars>
              {reorderItems.length === 0 ? (
                <Text size="xs" c="dimmed">Nenhuma coluna para reordenar.</Text>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={reorderItems}
                    strategy={verticalListSortingStrategy}
                  >
                    <Stack gap={4}>
                      {reorderItems.map((key, i) => (
                        <SortableColumnRow
                          key={key}
                          id={key}
                          label={labelByKey.get(key) ?? key}
                          index={i}
                          total={reorderItems.length}
                          onMoveUp={() =>
                            onReorder(arrayMove(reorderItems, i, i - 1))
                          }
                          onMoveDown={() =>
                            onReorder(arrayMove(reorderItems, i, i + 1))
                          }
                        />
                      ))}
                    </Stack>
                  </SortableContext>
                </DndContext>
              )}
            </ScrollArea.Autosize>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/**
 * One row of the reorder list: a drag handle (the only drag affordance —
 * the row itself is not draggable so the ▲▼ buttons stay clickable) plus
 * up/down buttons that nudge the column one slot. The ▲ is disabled on the
 * first row, the ▼ on the last.
 */
function SortableColumnRow({
  id,
  label,
  index,
  total,
  onMoveUp,
  onMoveDown,
}: {
  id: string;
  label: string;
  index: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined,
  };
  return (
    <Group ref={setNodeRef} style={style} gap={4} wrap="nowrap">
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={`Arrastar ${label}`}
        style={{ cursor: 'grab' }}
        {...attributes}
        {...listeners}
      >
        <IconGripVertical size={16} />
      </ActionIcon>
      <Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
        {label}
      </Text>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={`Mover ${label} para cima`}
        disabled={index === 0}
        onClick={onMoveUp}
      >
        <IconChevronUp size={16} />
      </ActionIcon>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={`Mover ${label} para baixo`}
        disabled={index === total - 1}
        onClick={onMoveDown}
      >
        <IconChevronDown size={16} />
      </ActionIcon>
    </Group>
  );
}
