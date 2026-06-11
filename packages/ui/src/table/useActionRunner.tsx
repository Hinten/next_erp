'use client';

import { useState, type ReactNode } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { ActionConfig } from '../schema/types';

/**
 * Shared bulk-action dispatcher for the ActionBar and the ActionSidePanel.
 * Routes actions that declare `confirm` through a Mantine Modal the hook
 * owns, so confirm semantics stay identical across layouts. The caller must
 * render `confirmModal` somewhere in its tree.
 */
export function useActionRunner<T>({
  selectedRows,
  onActionComplete,
}: {
  /** Rows currently checked in the table. */
  selectedRows: SnapshotRow<T>[];
  /** Called after a `refreshOnComplete` action finishes (e.g. delete). */
  onActionComplete?: () => void;
}): {
  trigger: (action: ActionConfig<T>) => Promise<void>;
  confirmModal: ReactNode;
} {
  const [pending, setPending] = useState<ActionConfig<T> | null>(null);

  async function execute(action: ActionConfig<T>) {
    await action.run(selectedRows);
    if (action.refreshOnComplete) onActionComplete?.();
  }

  async function trigger(action: ActionConfig<T>) {
    if (action.confirm) {
      setPending(action);
      return;
    }
    await execute(action);
  }

  const confirmModal = (
    <Modal
      opened={!!pending}
      onClose={() => setPending(null)}
      title={pending?.confirm?.title ?? 'Confirmar'}
      centered
    >
      <Stack>
        <Text>{pending?.confirm?.message}</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setPending(null)}>
            Cancelar
          </Button>
          <Button
            color={pending?.color ?? 'red'}
            onClick={async () => {
              const action = pending!;
              setPending(null);
              await execute(action);
            }}
          >
            Confirmar
          </Button>
        </Group>
      </Stack>
    </Modal>
  );

  return { trigger, confirmModal };
}
