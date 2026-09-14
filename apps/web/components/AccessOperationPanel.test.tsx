import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ACCESS_ACTION as A, ACCESS_PHASE as P, type AccessOperation } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
const m = vi.hoisted(() => ({
  read: vi.fn(),
  retry: vi.fn(),
  token: vi.fn().mockResolvedValue('token'),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { uid: 'actor', getIdToken: m.token } }) }));
vi.mock('@/lib/admin/access', () => ({
  readAccessOperation: m.read,
  retryAccessOperation: m.retry,
}));
import { AccessOperationPanel, useAccessOperationMemory } from './AccessOperationPanel';
const op: AccessOperation = {
  id: 'op',
  actorId: 'actor',
  ceiling: '3',
  command: {
    action: A.deleteCargo,
    targetId: 'role',
    expectedVersion: '1:0',
    cargo: null,
    usuario: null,
  },
  phase: P.validating,
  committed: false,
  cursor: null,
  validated: 100,
  processed: 0,
  updated: 0,
  unchanged: 0,
  missing: 0,
  external: 0,
  attempts: 0,
  startedAt: 1,
  progressAt: 1,
  finishedAt: null,
  leaseOwner: null,
  leaseUntil: 0,
  errorCode: null,
  errorMessage: null,
  errorTarget: null,
};
function wrap(child: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MantineTestProvider>{child}</MantineTestProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
describe('access operation progress', () => {
  it('does not claim the cargo was saved while validating', async () => {
    m.read.mockResolvedValue(op);
    wrap(<AccessOperationPanel id="op" />);
    expect(await screen.findByText(/o registro ainda não mudou/)).toBeTruthy();
    expect(screen.queryByText('Atualização concluída')).toBeNull();
  });
  it('shows a rejected operation and preserves its durable link', async () => {
    m.read.mockResolvedValue({
      ...op,
      phase: P.rejected,
      errorMessage: 'Permissões superiores',
      errorCode: 'CASCADE_PERMISSION',
    });
    const finished = vi.fn();
    wrap(<AccessOperationPanel id="op" onFinished={finished} />);
    expect(await screen.findByText(/Alteração rejeitada/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Acompanhar operação' }).getAttribute('href')).toBe(
      '/configuracoes/operacoes-acesso/op',
    );
    await waitFor(() => expect(finished).toHaveBeenCalledWith(false));
  });
  it('retries an interrupted propagation and keeps deletion observable', async () => {
    m.read
      .mockResolvedValueOnce({ ...op, phase: P.failed, committed: true })
      .mockResolvedValue({ ...op, phase: P.completed, committed: true, processed: 2, updated: 2 });
    wrap(<AccessOperationPanel id="op" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retomar atualização' }));
    expect(await screen.findByText('Atualização concluída')).toBeTruthy();
    expect(m.retry).toHaveBeenCalledWith('op', 'token');
    expect(screen.queryByRole('link', { name: 'Abrir registro' })).toBeNull();
  });
  it('restores the operation ID for the same user and editor after remount', async () => {
    function Host() {
      const { operationId, remember } = useAccessOperationMemory('cargo/role');
      return (
        <>
          <span>{operationId}</span>
          <button onClick={() => remember('saved-op')}>Save</button>
        </>
      );
    }
    const first = wrap(<Host />);
    fireEvent.click(screen.getByText('Save'));
    first.unmount();
    wrap(<Host />);
    expect(await screen.findByText('saved-op')).toBeTruthy();
  });
});
