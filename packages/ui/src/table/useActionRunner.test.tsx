import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import type { SnapshotRow } from '@delfrance/data/hooks';

const notifyShow = vi.fn();
vi.mock('@mantine/notifications', async () => {
  const actual =
    await vi.importActual<typeof import('@mantine/notifications')>('@mantine/notifications');
  return { ...actual, notifications: { show: (...args: unknown[]) => notifyShow(...args) } };
});

import { ActionSidePanel } from './ActionSidePanel';
import { useActionRunner } from './useActionRunner';
import type { ActionConfig } from '../schema/types';

type Row = { name: string };
const ROW: SnapshotRow<Row> = { id: '1', path: 'x/1', data: { name: 'a' } };

/**
 * Driven through `ActionSidePanel` rather than `renderHook`: the failure path
 * only exists because both call sites are floating async handlers, and a hook
 * test that awaits `trigger` would not reproduce that.
 */
function renderWithAction(action: ActionConfig<Row>, onActionComplete?: () => void) {
  return render(
    <MantineProvider env="test">
      <ActionSidePanel
        actions={[action]}
        selectedRows={[ROW]}
        collapsed={false}
        onToggleCollapsed={() => {}}
        onActionComplete={onActionComplete}
      />
    </MantineProvider>,
  );
}

describe('useActionRunner failure handling', () => {
  it('shows a FirebaseError from run as a notification naming the action', async () => {
    notifyShow.mockClear();
    const run = vi
      .fn()
      .mockRejectedValue(new FirebaseError('permission-denied', 'Missing permissions.'));
    renderWithAction({ id: 'delete', label: 'Excluir', run });

    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));

    await waitFor(() => {
      expect(notifyShow).toHaveBeenCalledWith({
        color: 'red',
        message: 'Excluir: Missing permissions.',
      });
    });
  });

  it('refreshes even when run rejected — a partial delete still changed the list', async () => {
    const onActionComplete = vi.fn();
    const run = vi.fn().mockRejectedValue(new FirebaseError('unavailable', 'Offline.'));
    renderWithAction(
      { id: 'delete', label: 'Excluir', refreshOnComplete: true, run },
      onActionComplete,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));

    await waitFor(() => {
      expect(onActionComplete).toHaveBeenCalledTimes(1);
    });
  });

  it('does not swallow a non-Firebase rejection', async () => {
    // A TypeError is a bug in the action, not a failed write — it must keep
    // propagating rather than being dressed up as a user-facing error.
    // Asserted at the hook boundary: through the panel it would surface as a
    // deliberate unhandled rejection, which fails the whole run.
    notifyShow.mockClear();
    const run = vi.fn().mockRejectedValue(new TypeError('undefined is not a function'));
    const { result } = renderHook(() =>
      useActionRunner<Row>({ selectedRows: [ROW], visibleRows: [ROW] }),
    );

    await expect(result.current.trigger({ id: 'oops', label: 'Ação', run })).rejects.toThrow(
      TypeError,
    );
    expect(notifyShow).not.toHaveBeenCalled();
  });

  it('runs a confirm action through the modal and still reports its failure', async () => {
    notifyShow.mockClear();
    const run = vi.fn().mockRejectedValue(new FirebaseError('permission-denied', 'Sem permissão.'));
    renderWithAction({
      id: 'delete',
      label: 'Excluir',
      confirm: { title: 'Excluir?', message: 'Tem certeza?' },
      run,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => {
      expect(notifyShow).toHaveBeenCalledWith({
        color: 'red',
        message: 'Excluir: Sem permissão.',
      });
    });
  });
});
