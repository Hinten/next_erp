import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { FirebaseError } from 'firebase/app';

const { notifShowMock, confirmMock, cancelarPedidoMock } = vi.hoisted(() => ({
  notifShowMock: vi.fn(),
  confirmMock: vi.fn(),
  cancelarPedidoMock: vi.fn(),
}));

vi.mock('@mantine/notifications', () => ({
  notifications: { show: notifShowMock },
}));
vi.mock('@/lib/auth/useAuth', () => ({
  useAuth: () => ({ user: { uid: 'u1' } }),
}));
vi.mock('@/lib/pedidos/clientPort', () => ({
  createClientPedidoPort: vi.fn(() => ({})),
}));
vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: vi.fn(() => ({})),
}));
vi.mock('@/app/(app)/pedidos/_components/ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmMock, element: null }),
}));
vi.mock('@delfrance/data/pedido', () => ({
  cancelarPedido: cancelarPedidoMock,
}));

import { useCancelarPedidoPrompt } from './useCancelarPedidoPrompt';

afterEach(() => {
  vi.clearAllMocks();
});

describe('useCancelarPedidoPrompt', () => {
  it('confirming the prompt cancels the pedido as the current user', async () => {
    confirmMock.mockResolvedValue(true);
    cancelarPedidoMock.mockResolvedValue(true);
    const { result } = renderHook(() => useCancelarPedidoPrompt());

    await result.current.promptCancelarPedido('PED-1');

    expect(confirmMock).toHaveBeenCalledWith({
      title: 'Cancelar pedido?',
      message: 'Também deseja cancelar o pedido?',
    });
    expect(cancelarPedidoMock).toHaveBeenCalledWith(expect.anything(), {
      pedidoId: 'PED-1',
      usuarioRef: 'documents/usuarios/u1',
    });
  });

  it('declining leaves the pedido untouched', async () => {
    confirmMock.mockResolvedValue(false);
    const { result } = renderHook(() => useCancelarPedidoPrompt());

    await result.current.promptCancelarPedido('PED-1');

    expect(confirmMock).toHaveBeenCalled();
    expect(cancelarPedidoMock).not.toHaveBeenCalled();
  });

  it('a FirebaseError warns without asserting the pedido stayed unchanged', async () => {
    confirmMock.mockResolvedValue(true);
    cancelarPedidoMock.mockRejectedValue(new FirebaseError('permission-denied', 'nope'));
    const { result } = renderHook(() => useCancelarPedidoPrompt());

    // Resolves — the NF-e cancelamento already succeeded and must stay reported.
    await result.current.promptCancelarPedido('PED-1');

    expect(notifShowMock).toHaveBeenCalledWith({
      color: 'yellow',
      message: 'Não foi possível confirmar o cancelamento do pedido — verifique o pedido.',
    });
  });

  it('rethrows anything that is not a FirebaseError', async () => {
    confirmMock.mockResolvedValue(true);
    cancelarPedidoMock.mockRejectedValue(new TypeError('bug'));
    const { result } = renderHook(() => useCancelarPedidoPrompt());

    await expect(result.current.promptCancelarPedido('PED-1')).rejects.toThrow(TypeError);
    expect(notifShowMock).not.toHaveBeenCalled();
  });
});
