import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '../testing/mantine';
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
const ROW2: SnapshotRow<Row> = { id: '2', path: 'x/2', data: { name: 'b' } };

/**
 * Driven through `ActionSidePanel` rather than `renderHook`: the failure path
 * only exists because both call sites are floating async handlers, and a hook
 * test that awaits `trigger` would not reproduce that.
 */
function renderWithAction(
  action: ActionConfig<Row>,
  onActionComplete?: () => void,
  selectedRows: SnapshotRow<Row>[] = [ROW],
) {
  const tree = (a: ActionConfig<Row>, rows: SnapshotRow<Row>[]) => (
    <MantineTestProvider>
      <ActionSidePanel
        actions={[a]}
        selectedRows={rows}
        collapsed={false}
        onToggleCollapsed={() => {}}
        onActionComplete={onActionComplete}
      />
    </MantineTestProvider>
  );
  const result = render(tree(action, selectedRows));
  return {
    ...result,
    /** Re-render with a different action/selection, keeping the modal open. */
    update: (a: ActionConfig<Row>, rows: SnapshotRow<Row>[] = selectedRows) =>
      result.rerender(tree(a, rows)),
  };
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

/**
 * The two ways a refused row could still end in "nothing happened, and nothing
 * said why" — the failure `rowIneligibleReason` exists to end.
 */
describe('useActionRunner eligibility', () => {
  /** This package has no jest-dom matchers; ActionBar.test.tsx reads it this way. */
  const confirmarDisabled = () =>
    (screen.getByRole('button', { name: 'Confirmar' }) as HTMLButtonElement).disabled;

  /**
   * Keys on row DATA, not on row id — the recompute re-partitions against fresh
   * `selectedRows` while still holding the action captured at trigger time, so
   * what changes mid-dialog is the streamed document, never the predicate.
   */
  const REFUSE_CANCELADO: ActionConfig<Row>['rowIneligibleReason'] = (r) =>
    r.data.name === 'cancelado' ? `${r.id}: cancelado` : null;
  const REFUSE_ROW2: ActionConfig<Row>['rowIneligibleReason'] = (r) =>
    r.id === '2' ? '2: bloqueado' : null;
  const cancelado = (r: SnapshotRow<Row>): SnapshotRow<Row> => ({
    ...r,
    data: { name: 'cancelado' },
  });

  it('disables Confirm once the streaming recompute leaves no eligible row', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const action: ActionConfig<Row> = {
      id: 'delete',
      label: 'Excluir',
      confirm: { title: 'Excluir?', message: 'Tem certeza?' },
      rowIneligibleReason: REFUSE_CANCELADO,
      run,
    };
    const { update } = renderWithAction(action, undefined, [ROW, ROW2]);

    // Opened while both rows were eligible — which is the only way to get here,
    // since `actionDisabledReason` disables the button once every row is refused.
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    expect(confirmarDisabled()).toBe(false);

    // The list streams (#40): both pedidos are cancelled with the dialog open.
    update(action, [cancelado(ROW), cancelado(ROW2)]);

    await waitFor(() => {
      expect(confirmarDisabled()).toBe(true);
    });
    expect(screen.getByText(/2 de 2 registros/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(run).not.toHaveBeenCalled();
  });

  it('disables Confirm when the selection EMPTIES under an open dialog', async () => {
    // The sibling of the refusal path, and reachable through machinery
    // TableView runs deliberately: its effect drops selected ids that left the
    // row set (TableView.tsx:1327-1339), so another operator moving a pedido
    // past the list filter — or deleting it — empties `selectedRows` with the
    // dialog open. Nothing is REFUSED here, so the refusal count stays 0.
    const run = vi.fn().mockResolvedValue(undefined);
    const action: ActionConfig<Row> = {
      id: 'delete',
      label: 'Excluir',
      requiresSelection: true,
      confirm: { title: 'Excluir?', message: 'Tem certeza?' },
      run,
    };
    const { update } = renderWithAction(action, undefined, [ROW]);

    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    expect(confirmarDisabled()).toBe(false);

    update(action, []);

    await waitFor(() => {
      expect(confirmarDisabled()).toBe(true);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps Confirm enabled when the action refuses nothing', () => {
    // Pins the guard's SCOPE: it must key on "everything was refused", not on
    // "no rows", or an action with no eligibility predicate loses its Confirm.
    const run = vi.fn().mockResolvedValue(undefined);
    renderWithAction(
      { id: 'delete', label: 'Excluir', confirm: { title: 'T', message: 'M' }, run },
      undefined,
      [],
    );

    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));

    expect(confirmarDisabled()).toBe(false);
  });

  it('names the dropped rows when a confirm-less action refuses some of them', async () => {
    notifyShow.mockClear();
    const run = vi.fn().mockResolvedValue(undefined);
    renderWithAction(
      { id: 'sync', label: 'Sincronizar', rowIneligibleReason: REFUSE_ROW2, run },
      undefined,
      [ROW, ROW2],
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar' }));

    await waitFor(() => {
      expect(notifyShow).toHaveBeenCalledWith({
        color: 'yellow',
        message: 'Sincronizar: 1 de 2 registros ficaram de fora — 2: bloqueado',
      });
    });
    expect(run).toHaveBeenCalledWith([ROW]);
  });

  it('does not repeat the refusal notice for an action whose dialog already listed it', async () => {
    notifyShow.mockClear();
    const run = vi.fn().mockResolvedValue(undefined);
    renderWithAction(
      {
        id: 'delete',
        label: 'Excluir',
        confirm: { title: 'Excluir?', message: 'Tem certeza?' },
        rowIneligibleReason: REFUSE_ROW2,
        run,
      },
      undefined,
      [ROW, ROW2],
    );

    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    expect(screen.getByText(/1 de 2 registros/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(run).toHaveBeenCalledWith([ROW]));
    expect(notifyShow).not.toHaveBeenCalled();
  });
});
