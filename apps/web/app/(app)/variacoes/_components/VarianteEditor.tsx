'use client';

import { useMemo } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconArrowBackUp, IconGripVertical, IconPlus, IconTrash } from '@tabler/icons-react';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Variante } from '@delfrance/schemas';
import { DELETE_MARK } from '@delfrance/ui';

/** A `Variante` plus the transient staged-deletion marker (keyed by `DELETE_MARK`). */
type EditableVariante = Variante & { [DELETE_MARK]?: boolean };

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Mint an 8-char alphanumeric id, unique within the group, mirroring the
 * Flutter `GrupoDeVariacoes.generateIdVariacao` / `gerarStringAleatoria(8)`.
 * The id is embedded as the last path segment of a foto/child `variantePath`,
 * so it stays short and slash-free.
 */
function genVarianteId(existing: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let id = '';
    for (let i = 0; i < 8; i += 1) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    if (!existing.has(id)) return id;
  }
  throw new Error('Não foi possível gerar um id de variante.');
}

export interface VarianteEditorProps {
  /** Current `GrupoDeVariacoes.variacoes` value from the form. */
  value: Variante[] | null;
  /** Push a new `variacoes` array back into the form (RHF tracks it as dirty). */
  onChange: (next: Variante[]) => void;
  disabled?: boolean;
  /** Field-level validation message from the schema resolver. */
  error?: string;
}

/**
 * Editor for the embedded `GrupoDeVariacoes.variacoes` list. Each row is a
 * `{ nome, codigo }` pair; order is the array position (Flutter sorts/indexes
 * variants by position). Deletion is staged (mark + undo) per the app-wide
 * convention — the parent ObjectView strips marked rows on save via
 * `prepareForSave: stripMarkedForDeletion`, and derives `variacoesIds` from the
 * survivors via `deriveOnSave`.
 */
export function VarianteEditor({ value, onChange, disabled, error }: VarianteEditorProps) {
  const variantes = useMemo<EditableVariante[]>(() => value ?? [], [value]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function addVariante() {
    const ids = new Set(variantes.map((v) => v.id));
    onChange([...variantes, { id: genVarianteId(ids), nome: '', codigo: null }]);
  }

  function patch(index: number, changes: Partial<Variante>) {
    onChange(variantes.map((v, i) => (i === index ? { ...v, ...changes } : v)));
  }

  function toggleDelete(index: number) {
    onChange(variantes.map((v, i) => (i === index ? { ...v, [DELETE_MARK]: !v[DELETE_MARK] } : v)));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = variantes.findIndex((v) => v.id === active.id);
    const to = variantes.findIndex((v) => v.id === over.id);
    if (from < 0 || to < 0) return;
    onChange(arrayMove(variantes, from, to));
  }

  return (
    <Stack gap="xs">
      {error && <Alert color="red">{error}</Alert>}

      {variantes.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nenhuma variante. Adicione os tamanhos, cores, etc. deste grupo.
        </Text>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={variantes.map((v) => v.id)}
            strategy={verticalListSortingStrategy}
          >
            <Stack gap="xs">
              {variantes.map((variante, index) => (
                <SortableVariante
                  key={variante.id}
                  variante={variante}
                  marked={!!variante[DELETE_MARK]}
                  disabled={disabled}
                  onNome={(nome) => patch(index, { nome })}
                  onCodigo={(codigo) => patch(index, { codigo: codigo === '' ? null : codigo })}
                  onToggleDelete={() => toggleDelete(index)}
                />
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      )}

      {!disabled && (
        <Group>
          <Button
            variant="light"
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={addVariante}
          >
            Adicionar variante
          </Button>
        </Group>
      )}
    </Stack>
  );
}

interface SortableVarianteProps {
  variante: EditableVariante;
  /** Marked for deletion — rendered dimmed with an undo button. */
  marked: boolean;
  disabled?: boolean;
  onNome: (value: string) => void;
  onCodigo: (value: string) => void;
  onToggleDelete: () => void;
}

function SortableVariante({
  variante,
  marked,
  disabled,
  onNome,
  onCodigo,
  onToggleDelete,
}: SortableVarianteProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: variante.id,
    disabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : marked ? 0.55 : 1,
    borderColor: marked ? 'var(--mantine-color-red-6)' : undefined,
  };

  return (
    <Paper ref={setNodeRef} style={style} withBorder p="xs">
      <Group wrap="nowrap" align="flex-end" gap="xs">
        {!disabled && (
          <ActionIcon
            variant="subtle"
            mb={4}
            style={{ cursor: 'grab' }}
            aria-label="Reordenar"
            {...attributes}
            {...listeners}
          >
            <IconGripVertical size={16} />
          </ActionIcon>
        )}
        <TextInput
          label="Nome"
          value={variante.nome}
          onChange={(e) => onNome(e.currentTarget.value)}
          disabled={disabled || marked}
          style={{ flex: 1 }}
        />
        <TextInput
          label="Código"
          value={variante.codigo ?? ''}
          onChange={(e) => onCodigo(e.currentTarget.value)}
          disabled={disabled || marked}
          w={120}
        />
        {marked && (
          <Badge color="red" variant="light" mb={6}>
            Será excluída
          </Badge>
        )}
        {!disabled &&
          (marked ? (
            <ActionIcon
              variant="subtle"
              color="blue"
              mb={4}
              onClick={onToggleDelete}
              aria-label="Desfazer exclusão"
            >
              <IconArrowBackUp size={16} />
            </ActionIcon>
          ) : (
            <ActionIcon
              variant="subtle"
              color="red"
              mb={4}
              onClick={onToggleDelete}
              aria-label="Remover variante"
            >
              <IconTrash size={16} />
            </ActionIcon>
          ))}
      </Group>
    </Paper>
  );
}
