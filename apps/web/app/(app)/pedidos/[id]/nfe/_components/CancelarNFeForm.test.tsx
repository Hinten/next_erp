import { useState } from 'react';
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
    wrap(<CancelarNFeForm pedidoId="PED-1" nfeId="s1" numero={42} />);

    fillAndConfirm();

    await waitFor(() => expect(cancelarMock).toHaveBeenCalledWith('PED-1', 's1', VALID_XJUST));
    expect(notifShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'teal', title: 'NF-e cancelada' }),
    );
  });

  it('on a SEFAZ rejection, shows a clean cStat message and stays on the form', async () => {
    const onConcluido = vi.fn();
    cancelarMock.mockRejectedValue(
      new NFeRejectedError('573', 'Rejeicao: Duplicidade de Evento', {}),
    );
    wrap(<CancelarNFeForm pedidoId="PED-1" nfeId="s1" onCancelamentoConcluido={onConcluido} />);

    fillAndConfirm();

    await waitFor(() => expect(showErrorMock).toHaveBeenCalled());
    expect(showErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'SEFAZ rejeitou o cancelamento (cStat 573): Rejeicao: Duplicidade de Evento',
      }),
    );
    // A rejected cancelamento never reaches the pedido-cancel follow-up.
    expect(onConcluido).not.toHaveBeenCalled();
  });

  it('hands off to onCancelamentoConcluido after a homologated cancelamento', async () => {
    const onConcluido = vi.fn().mockResolvedValue(undefined);
    cancelarMock.mockResolvedValue({ estado: 'c', cStat: '135' });
    wrap(<CancelarNFeForm pedidoId="PED-1" nfeId="s1" onCancelamentoConcluido={onConcluido} />);

    fillAndConfirm();

    await waitFor(() => expect(onConcluido).toHaveBeenCalledTimes(1));
    // The follow-up runs only after the NF-e success was already reported.
    expect(notifShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'teal', title: 'NF-e cancelada' }),
    );
  });

  it('the follow-up survives this form unmounting mid-flight', async () => {
    // The regression this guards: `POST /api/nfe/cancelar` persists estado 'c'
    // before answering, so the screen's onSnapshot flips the NF-e to `cancelada`
    // and unmounts this form within milliseconds of `cancelar()` resolving. The
    // follow-up prompt must be owned by the page (which stays mounted) — when it
    // lived inside this component its dialog was torn down here and its promise
    // never settled, so the operator never saw it.
    cancelarMock.mockResolvedValue({ estado: 'c', cStat: '135' });
    const started = vi.fn();
    const finished = vi.fn();
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    function Harness() {
      const [aprovada, setAprovada] = useState(true);
      return (
        <>
          <button onClick={() => setAprovada(false)}>flip</button>
          {aprovada && (
            <CancelarNFeForm
              pedidoId="PED-1"
              nfeId="s1"
              onCancelamentoConcluido={async () => {
                started();
                await pending;
                finished();
              }}
            />
          )}
        </>
      );
    }

    wrap(<Harness />);
    fillAndConfirm();

    await waitFor(() => expect(started).toHaveBeenCalled());
    // The NF-e doc flips to `cancelada` → the form goes away.
    fireEvent.click(screen.getByRole('button', { name: 'flip' }));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Descreva o motivo do cancelamento')).toBeNull(),
    );

    release();
    await waitFor(() => expect(finished).toHaveBeenCalledTimes(1));
  });
});
