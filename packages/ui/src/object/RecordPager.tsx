'use client';

import { useState } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';

export interface RecordPagerProps {
  ids: string[];
  current: string;
  onChange: (id: string) => void;
  /**
   * Called before nav when the form is dirty; resolves with `true` if the
   * user confirms discard. When undefined, navigation is unconditional.
   */
  confirmNavigation?: (nextId: string) => boolean | Promise<boolean>;
}

/**
 * Prev/next navigator across a set of record ids. Owned by the ObjectView,
 * which threads in `confirmNavigation` when the form is dirty so the user
 * gets a "Descartar alterações?" modal rather than silent data loss.
 */
export function RecordPager({
  ids,
  current,
  onChange,
  confirmNavigation,
}: RecordPagerProps) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const idx = ids.indexOf(current);
  const prev = idx > 0 ? ids[idx - 1] : null;
  const next = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null;

  async function tryNav(nextId: string) {
    if (confirmNavigation) {
      const ok = await confirmNavigation(nextId);
      if (!ok) {
        setPendingId(nextId);
        return;
      }
    }
    onChange(nextId);
  }

  return (
    <>
      <Group gap="xs" justify="center">
        <Button variant="default" size="xs" disabled={!prev} onClick={() => prev && tryNav(prev)}>
          ‹ Anterior
        </Button>
        <Text size="sm" c="dimmed">
          {idx >= 0 ? `${idx + 1} / ${ids.length}` : ''}
        </Text>
        <Button variant="default" size="xs" disabled={!next} onClick={() => next && tryNav(next)}>
          Próximo ›
        </Button>
      </Group>

      <Modal
        opened={!!pendingId}
        onClose={() => setPendingId(null)}
        title="Descartar alterações?"
        centered
      >
        <Stack>
          <Text size="sm">
            Você tem alterações não salvas neste registro. Continuar irá descartá-las.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPendingId(null)}>Cancelar</Button>
            <Button color="red" onClick={() => {
              const id = pendingId!;
              setPendingId(null);
              onChange(id);
            }}>
              Descartar
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
