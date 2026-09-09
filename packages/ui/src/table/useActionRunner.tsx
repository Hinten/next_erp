'use client';

import { useState, type ReactNode } from 'react';
import { Alert, Button, Group, List, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { ActionConfig } from '../schema/types';
import { partitionActionRows, type RefusedRow } from './resolveActionRows';

/** How many refusal reasons a notification names before it starts counting. */
const MAX_LISTED_REFUSALS = 3;

/**
 * Operator-facing summary of the rows an action refused.
 *
 * Names the first few outright rather than only counting them: a reason
 * carries the record's own identifier (`emit-nfe` returns
 * `"1234: frete cancelado"`), and that is what lets someone go and fix it.
 * The tail is COUNTED, never dropped — a silent cap would read as "those were
 * all of them", which is the failure this message exists to prevent.
 */
function refusalMessage<T>(
  label: string,
  eligibleCount: number,
  refused: ReadonlyArray<RefusedRow<T>>,
): string {
  const total = eligibleCount + refused.length;
  const shown = refused.slice(0, MAX_LISTED_REFUSALS).map((r) => r.reason);
  const rest = refused.length - shown.length;
  const tail = rest > 0 ? ` e mais ${rest}` : '';
  return `${label}: ${refused.length} de ${total} registros ficaram de fora — ${shown.join('; ')}${tail}`;
}

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
    const { eligible: rows, refused } = partitionActionRows(action, selectedRows, visibleRows);
    // A `confirm`-less action never opens the modal, so the Alert below that
    // lists refusals is unreachable and the drop is SILENT: the operator
    // selects twelve, ten run, and the count quietly disagrees with the
    // selection — the very problem `rowIneligibleReason` was added to end.
    //
    // `actionDisabledReason` does not cover this. It only fires when EVERY row
    // was refused (the button disables and its title says which); the PARTIAL
    // case is invisible on this path. No consumer hits it today — `emit-nfe`
    // declares a `confirm` — but nothing in `ActionConfig` ties the two
    // together, so the next one would get the silent drop back.
    if (refused.length > 0 && !action.confirm) {
      notifications.show({
        color: 'yellow',
        message: refusalMessage(action.label, rows.length, refused),
      });
    }
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

  // Recomputed for the pending action rather than captured at trigger time:
  // the list streams (#40), so a row can become eligible — or stop being —
  // while the dialog is open, and the operator must confirm against what will
  // actually run, not against what was true when they clicked.
  const pendingSplit = pending
    ? partitionActionRows(pending, selectedRows, visibleRows)
    : { eligible: [], refused: [] };
  const pendingRefused = pendingSplit.refused;

  const confirmModal = (
    <Modal
      opened={!!pending}
      onClose={() => setPending(null)}
      title={pending?.confirm?.title ?? 'Confirmar'}
      centered
    >
      <Stack>
        <Text>{pending?.confirm?.message}</Text>
        {pendingRefused.length > 0 && (
          <Alert color="yellow" variant="light" title="Alguns registros serão ignorados">
            <Stack gap={4}>
              <Text size="sm">
                {`${pendingRefused.length} de ${pendingRefused.length + pendingSplit.eligible.length} registros não aceitam esta ação e ficarão de fora:`}
              </Text>
              <List size="sm" withPadding>
                {pendingRefused.map(({ row, reason }) => (
                  <List.Item key={row.id}>{reason}</List.Item>
                ))}
              </List>
            </Stack>
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setPending(null)}>
            Cancelar
          </Button>
          <Button
            color={pending?.color ?? 'red'}
            /**
             * The recompute above found every row refused, so `run` would
             * receive an empty list. Each `run` opens with a length guard
             * (`dispatchEmitirNFe`: `if (rows.length === 0) return;`), so the
             * modal would close and NOTHING would happen, with no
             * notification — the "nothing happens when I click it" failure
             * `actionDisabledReason` exists to prevent, reached here because
             * the button that opened this dialog was enabled back when the
             * rows were still eligible. The Alert already says why.
             *
             * ⚠️ Deliberately NOT `eligible.length === 0` on its own. An
             * action with no `rowIneligibleReason` refuses nothing ever, so
             * the broader condition would also disable Confirm for an empty
             * selection — a case this PR does not touch and which a
             * `requiresSelection: false` action may legitimately run on.
             */
            disabled={pendingSplit.eligible.length === 0 && pendingRefused.length > 0}
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
