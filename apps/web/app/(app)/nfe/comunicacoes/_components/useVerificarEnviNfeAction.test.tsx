import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { NFeServerError } from '@delfrance/integrations-nfe/http-provider';
import type { EnviNFeMsg } from '@delfrance/schemas';

const { verificarMock, useNFeClientMock, showErrorMock } = vi.hoisted(() => ({
  verificarMock: vi.fn(),
  useNFeClientMock: vi.fn(),
  showErrorMock: vi.fn(),
}));

vi.mock('@/lib/nfe/client', () => ({
  useNFeClient: useNFeClientMock,
}));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showErrorNotification: showErrorMock,
}));

import { useVerificarEnviNfeAction } from './useVerificarEnviNfeAction';

function row(id: string) {
  return { id, path: `filiais/F-1/enviNfe/${id}`, data: {} as EnviNFeMsg };
}

const RESULT = {
  filialId: 'F-1',
  results: [
    {
      chave: '1'.repeat(44),
      status: 'atualizada',
      estadoAnterior: 'e',
      estadoNovo: 'a',
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
      error: null,
    },
  ],
  msgsNaoEncontradas: [],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('useVerificarEnviNfeAction', () => {
  it('0 selected rows → notification, client never called', async () => {
    useNFeClientMock.mockReturnValue({ verificar: verificarMock });
    const { result } = renderHook(() => useVerificarEnviNfeAction('F-1'));

    await act(() => result.current.action.run([]));

    expect(showErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Selecione exatamente 1 comunicação para verificar.' }),
    );
    expect(verificarMock).not.toHaveBeenCalled();
    expect(result.current.modal.opened).toBe(false);
  });

  it('2 selected rows → notification, client never called', async () => {
    useNFeClientMock.mockReturnValue({ verificar: verificarMock });
    const { result } = renderHook(() => useVerificarEnviNfeAction('F-1'));

    await act(() => result.current.action.run([row('m1'), row('m2')]));

    expect(showErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Selecione exatamente 1 comunicação para verificar.' }),
    );
    expect(verificarMock).not.toHaveBeenCalled();
  });

  it('1 selected row → verificar(filialId, [id]) and the modal receives the results', async () => {
    useNFeClientMock.mockReturnValue({ verificar: verificarMock });
    verificarMock.mockResolvedValue(RESULT);
    const { result } = renderHook(() => useVerificarEnviNfeAction('F-1'));

    await act(() => result.current.action.run([row('m1')]));

    expect(verificarMock).toHaveBeenCalledWith('F-1', ['m1']);
    expect(result.current.modal.opened).toBe(true);
    expect(result.current.modal.result).toEqual(RESULT);

    act(() => result.current.modal.close());
    expect(result.current.modal.opened).toBe(false);
  });

  it('logged out (client null) → notification, no crash', async () => {
    useNFeClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useVerificarEnviNfeAction('F-1'));

    await act(() => result.current.action.run([row('m1')]));

    expect(showErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Você não está logado' }),
    );
    expect(verificarMock).not.toHaveBeenCalled();
  });

  it('NFeHttpError from the client → copyable error notification, no modal, no rethrow', async () => {
    useNFeClientMock.mockReturnValue({ verificar: verificarMock });
    verificarMock.mockRejectedValue(new NFeServerError('boom no servidor', 500, null));
    const { result } = renderHook(() => useVerificarEnviNfeAction('F-1'));

    await act(() => result.current.action.run([row('m1')]));

    expect(showErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'red', message: 'boom no servidor' }),
    );
    expect(result.current.modal.opened).toBe(false);
  });
});
