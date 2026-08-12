'use client';

import { useState, type ReactNode } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { ActionConfig } from '../schema/types';
import { resolveActionRows } from './resolveActionRows';

/**
 * Shared bulk-action dispatcher for the ActionBar and the ActionSidePanel.
 * Routes actions that declare `confirm` through a Mantine Modal the hook
 * owns, so confirm semantics stay identical across layouts. The caller must
 * render `confirmModal` somewhere in its tree.
 */
export function useActionRunner<T>({
  selectedRows,
  visibleRows = [],
  onActionComplete,
}: {
  /** Rows currently checked in the table. */
  selectedRows: SnapshotRow<T>[];
  /**
   * Rows currently shown in the table (filtered page). Used when an action
   * sets `fallbackToSingleVisibleRow` and nothing is selected.
   */
  visibleRows?: SnapshotRow<T>[];
  /** Called after a `refreshOnComplete` action finishes (e.g. delete). */
  onActionComplete?: () => void;
}): {
  trigger: (action: ActionConfig<T>) => Promise<void>;
  confirmModal: ReactNode;
} {
  const [pending, setPending] = useState<ActionConfig<T> | null>(null);

  /**
   * Runs the action and makes a rejection VISIBLE. Both call sites are
   * floating async handlers (the confirm Modal's `onClick`, and `trigger` for
   * an action with no `confirm`), so an uncaught rejection here used to reach
   * the operator as nothing at all — the modal just closed. A `deleteDoc` the
   * Firestore rules refuse is exactly that shape.
   *
   * Only `FirebaseError` is treated as a failed action; anything else is a bug
   * in the action itself and is rethrown, per root `CLAUDE.md` rule 6 and the
   * same split `ObjectView` makes on save.
   *
   * `onActionComplete` runs in a `finally` because a partial failure still
   * changed data: a delete action fans out with `Promise.all`, so a rejection
   * can leave some rows gone and the list stale.
   */
  async function execute(action: ActionConfig<T>) {
    const rows = resolveActionRows(action, selectedRows, visibleRows);
    try {
      await action.run(rows);
    } catch (err) {
      if (!(err instanceof FirebaseError)) throw err;
      notifications.show({ color: 'red', message: `${action.label}: ${err.message}` });
    } finally {
      if (action.refreshOnComplete) onActionComplete?.();
    }
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
