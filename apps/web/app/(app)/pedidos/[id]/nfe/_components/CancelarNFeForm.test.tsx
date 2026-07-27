import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import { NFeRejectedError } from '@delfrance/integrations-nfe/http-provider';

const { cancelarMock, showErrorMock, notifShowMock, confirmMock, cancelarPedidoMock } = vi.hoisted(
  () => ({
    cancelarMock: vi.fn(),
    showErrorMock: vi.fn(),
    notifShowMock: vi.fn(),
    confirmMock: vi.fn(),
    cancelarPedidoMock: vi.fn(),
  }),
);

vi.mock('@/lib/nfe/client', () => ({
  useNFeClient: () => ({ cancelar: cancelarMock }),
}));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showErrorNotification: showErrorMock,
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

import { CancelarNFeForm } from './CancelarNFeForm';

function wrap(node: React.ReactNode) {
  return render(<MantineProvider env="test">{node}</MantineProvider>);
}

const VALID_XJUST = 'Cancelamento por erro de digitacao no pedido';

function fillAndConfirm() {
  fireEvent.change(screen.getByPlaceholderText('Descreva o motivo do cancelamento'), {
    target: { value: VALID_XJUST },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar NF-e' }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('CancelarNFeForm', () => {
  it('cancels the specific nfeId on submit', async () => {
    cancelarMock.mockResolvedValue({ estado: 'c', cStat: '135' });
    confirmMock.mockResolvedValue(false);
    wrap(<CancelarNFeForm pedidoId="PED-1" nfeId="s1" numero={42} />);

    fillAndConfirm();

    await waitFor(() => expect(cancelarMock).toHaveBeenCalledWith('PED-1', 's1', VALID_XJUST));
    expect(notifShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'teal', title: 'NF-e cancelada' }),
    );
  });

  it('on a SEFAZ rejection, shows a clean cStat message and stays on the form', async () => {
    cancelarMock.mockRejectedValue(
      new NFeRejectedError('573', 'Rejeicao: Duplicidade de Evento', {}),
    );
    wrap(<CancelarNFeForm pedidoId="PED-1" nfeId="s1" />);

    fillAndConfirm();

    await waitFor(() => expect(showErrorMock).toHaveBeenCalled());
    expect(showErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'SEFAZ rejeitou o cancelamento (cStat 573): Rejeicao: Duplicidade de Evento',
      }),
    );
    // A rejected cancelamento never reaches the pedido-cancel prompt.
    expect(confirmMock).not.toHaveBeenCalled();
    expect(cancelarPedidoMock).not.toHaveBeenCalled();
  });

  it('confirming the prompt also cancels the pedido', async () => {
    cancelarMock.mockResolvedValue({ estado: 'c', cStat: '135' });
    confirmMock.mockResolvedValue(true);
    cancelarPedidoMock.mockResolvedValue(true);
    wrap(<CancelarNFeForm pedidoId="PED-1" nfeId="s1" />);

    fillAndConfirm();

    await waitFor(() =>
      expect(confirmMock).toHaveBeenCalledWith({
        title: 'Cancelar pedido?',
        message: 'Também deseja cancelar o pedido?',
      }),
    );
    await waitFor(() =>
      expect(cancelarPedidoMock).toHaveBeenCalledWith(expect.anything(), {
        pedidoId: 'PED-1',
        usuarioRef: 'documents/usuarios/u1',
      }),
    );
  });

  it('declining the prompt leaves the pedido untouched', async () => {
    cancelarMock.mockResolvedValue({ estado: 'c', cStat: '135' });
    confirmMock.mockResolvedValue(false);
    wrap(<CancelarNFeForm pedidoId="PED-1" nfeId="s1" />);

    fillAndConfirm();

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(cancelarPedidoMock).not.toHaveBeenCalled();
  });

  it('a pedido-cancel failure does not undo the reported NF-e cancelamento success', async () => {
    cancelarMock.mockResolvedValue({ estado: 'c', cStat: '135' });
    confirmMock.mockResolvedValue(true);
    cancelarPedidoMock.mockRejectedValue(new FirebaseError('permission-denied', 'nope'));
    wrap(<CancelarNFeForm pedidoId="PED-1" nfeId="s1" />);

    fillAndConfirm();

    await waitFor(() =>
      expect(notifShowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          color: 'yellow',
          message: 'Não foi possível confirmar o cancelamento do pedido — verifique o pedido.',
        }),
      ),
    );
    // The NF-e cancelamento toast fired earlier and is untouched by the pedido failure.
    expect(notifShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'teal', title: 'NF-e cancelada' }),
    );
    expect(showErrorMock).not.toHaveBeenCalled();
  });
});
