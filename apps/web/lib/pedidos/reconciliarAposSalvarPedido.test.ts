import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import { ESTADO_PEDIDO } from '@delfrance/schemas';

const { callMock, showMock, hideMock } = vi.hoisted(() => ({
  callMock: vi.fn(),
  showMock: vi.fn(),
  hideMock: vi.fn(),
}));

vi.mock('@/lib/pedidos/clientPort', () => ({
  callReconciliarPagamentoPedido: callMock,
}));
vi.mock('@mantine/notifications', () => ({
  notifications: { show: showMock, hide: hideMock },
}));

import { reconciliarEstadoSeTotalMudou } from './reconciliarAposSalvarPedido';

const MUDOU_NO_CARRINHO = { totalMudou: true, estadoGravado: ESTADO_PEDIDO.carrinho };

describe('reconciliarEstadoSeTotalMudou (#703)', () => {
  beforeEach(() => {
    callMock.mockReset();
    showMock.mockClear();
    hideMock.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the server to reconcile with the items-editable gate when the total moved', async () => {
    callMock.mockResolvedValue({ transition: ESTADO_PEDIDO.pago });
    await reconciliarEstadoSeTotalMudou('p1', MUDOU_NO_CARRINHO);
    expect(callMock).toHaveBeenCalledWith('p1', { aposAlterarTotal: true });
    expect(showMock).not.toHaveBeenCalled();
  });

  it('does not call at all when the total did not move', async () => {
    await reconciliarEstadoSeTotalMudou('p1', { ...MUDOU_NO_CARRINHO, totalMudou: false });
    expect(callMock).not.toHaveBeenCalled();
  });

  it('does not call for a pedido committed past the cart phase (the ML import race)', async () => {
    await reconciliarEstadoSeTotalMudou('p1', {
      totalMudou: true,
      estadoGravado: ESTADO_PEDIDO.emProcessamento,
    });
    expect(callMock).not.toHaveBeenCalled();
  });

  it('surfaces a callable failure as a toast instead of rejecting', async () => {
    callMock.mockRejectedValue(new FirebaseError('functions/not-found', 'not found'));
    await expect(reconciliarEstadoSeTotalMudou('p1', MUDOU_NO_CARRINHO)).resolves.toBeUndefined();
    expect(hideMock).toHaveBeenCalledWith('pedido-reconcile-total-falhou');
    expect(showMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'pedido-reconcile-total-falhou',
        color: 'red',
        message: expect.stringContaining('functions/not-found'),
      }),
    );
  });

  it('rethrows anything that is not a FirebaseError', async () => {
    const bug = new TypeError('boom');
    callMock.mockRejectedValue(bug);
    await expect(reconciliarEstadoSeTotalMudou('p1', MUDOU_NO_CARRINHO)).rejects.toBe(bug);
    expect(showMock).not.toHaveBeenCalled();
  });
});
