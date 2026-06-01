import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { NFeRejectedError } from '@delfrance/integrations-nfe/http-provider';

const { cancelarMock, showErrorMock, notifShowMock } = vi.hoisted(() => ({
  cancelarMock: vi.fn(),
  showErrorMock: vi.fn(),
  notifShowMock: vi.fn(),
}));

vi.mock('@/lib/nfe/client', () => ({
  useNFeClient: () => ({ cancelar: cancelarMock }),
}));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showErrorNotification: showErrorMock,
}));
vi.mock('@mantine/notifications', () => ({
  notifications: { show: notifShowMock },
}));

import { CancelarNFeForm } from './CancelarNFeForm';

function wrap(node: React.ReactNode) {
  return render(<MantineProvider env="test">{node}</MantineProvider>);
}

const VALID_XJUST = 'Cancelamento por erro de digitacao no pedido';

function fillAndConfirm() {
  fireEvent.change(
    screen.getByPlaceholderText('Descreva o motivo do cancelamento'),
    { target: { value: VALID_XJUST } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar NF-e' }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('CancelarNFeForm', () => {
  it('cancels the specific nfeId on submit', async () => {
    cancelarMock.mockResolvedValue({ estado: 'c', cStat: '135' });
    wrap(<CancelarNFeForm pedidoId="PED-1" nfeId="s1" numero={42} />);

    fillAndConfirm();

    await waitFor(() =>
      expect(cancelarMock).toHaveBeenCalledWith('PED-1', 's1', VALID_XJUST),
    );
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
  });
});
