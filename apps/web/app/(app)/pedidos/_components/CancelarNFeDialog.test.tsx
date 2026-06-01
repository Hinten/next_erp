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

import { CancelarNFeDialog } from './CancelarNFeDialog';

function wrap(node: React.ReactNode) {
  return render(<MantineProvider env="test">{node}</MantineProvider>);
}

const VALID_XJUST = 'Cancelamento por erro de digitacao no pedido';

function fillJustAndConfirm() {
  fireEvent.change(
    screen.getByPlaceholderText('Descreva o motivo do cancelamento'),
    { target: { value: VALID_XJUST } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar cancelamento' }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('CancelarNFeDialog', () => {
  it('does not let clicks inside the modal bubble to a parent row onClick', () => {
    const rowClick = vi.fn();
    wrap(
      <div onClick={rowClick}>
        <CancelarNFeDialog opened pedidoId="PED-1" onClose={vi.fn()} />
      </div>,
    );
    // The modal portals in the DOM, but React events bubble through the React
    // tree — the dialog's stopPropagation wrapper must catch this click before
    // it reaches the (row) parent onClick.
    fireEvent.click(screen.getByPlaceholderText('Descreva o motivo do cancelamento'));
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('on a SEFAZ rejection, shows a clean cStat message + keeps the dialog open', async () => {
    cancelarMock.mockRejectedValue(
      new NFeRejectedError('573', 'Rejeicao: NF-e fora do prazo de cancelamento', {}),
    );
    const onClose = vi.fn();
    wrap(<CancelarNFeDialog opened pedidoId="PED-1" onClose={onClose} />);

    fillJustAndConfirm();

    await waitFor(() => expect(showErrorMock).toHaveBeenCalled());
    expect(showErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'SEFAZ rejeitou o cancelamento (cStat 573): Rejeicao: NF-e fora do prazo de cancelamento',
      }),
    );
    // The NF-e stays aprovada and the dialog stays open for a retry.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('on success, shows a success toast + closes', async () => {
    cancelarMock.mockResolvedValue({ estado: 'c', cStat: '135' });
    const onClose = vi.fn();
    wrap(<CancelarNFeDialog opened pedidoId="PED-1" numero={42} onClose={onClose} />);

    fillJustAndConfirm();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(notifShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'teal', title: 'NF-e cancelada' }),
    );
    expect(cancelarMock).toHaveBeenCalledWith('PED-1', VALID_XJUST);
  });
});
