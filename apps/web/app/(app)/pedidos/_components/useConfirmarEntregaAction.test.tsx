import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { FirebaseError } from 'firebase/app';
import type { Pedido } from '@delfrance/schemas';

const { confirmarEntregaPedidoMock, notifyMock } = vi.hoisted(() => ({
  confirmarEntregaPedidoMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock('@delfrance/data/pedido', () => ({
  confirmarEntregaPedido: confirmarEntregaPedidoMock,
}));
vi.mock('@/lib/pedidos/clientPort', () => ({
  createClientPedidoPort: () => ({}),
}));
vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: () => ({}),
}));
vi.mock('@mantine/notifications', () => ({
  notifications: { show: notifyMock },
}));

import { useConfirmarEntregaAction } from './useConfirmarEntregaAction';

function row(id: string, numero: string | null = null) {
  return { id, path: `pedidos/${id}`, data: { numero } as Pedido };
}

describe('useConfirmarEntregaAction', () => {
  beforeEach(() => {
    confirmarEntregaPedidoMock.mockReset();
    notifyMock.mockClear();
  });

  it('exposes a multi-selection action', () => {
    const { result } = renderHook(() => useConfirmarEntregaAction());
    expect(result.current.action.id).toBe('confirmar-entrega');
    expect(result.current.action.label).toBe('Confirmar entrega');
    expect(result.current.action.requiresSelection).toBe(true);
    expect(result.current.action.refreshOnComplete).toBe(true);
    expect(result.current.action.maxSelection).toBeUndefined();
  });

  it('no-ops when run with no rows', async () => {
    const { result } = renderHook(() => useConfirmarEntregaAction());
    await result.current.action.run([]);
    expect(confirmarEntregaPedidoMock).not.toHaveBeenCalled();
  });

  it('calls confirmarEntregaPedido per selected pedido and reports success', async () => {
    confirmarEntregaPedidoMock.mockResolvedValue('confirmado');
    const { result } = renderHook(() => useConfirmarEntregaAction());

    await result.current.action.run([row('p1'), row('p2')]);

    expect(confirmarEntregaPedidoMock).toHaveBeenCalledTimes(2);
    expect(confirmarEntregaPedidoMock).toHaveBeenCalledWith({}, { pedidoId: 'p1' });
    expect(confirmarEntregaPedidoMock).toHaveBeenCalledWith({}, { pedidoId: 'p2' });
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'green', message: expect.stringContaining('2') }),
    );
  });

  it('reports a blocked pedido by numero, without a success toast', async () => {
    confirmarEntregaPedidoMock.mockResolvedValue('bloqueado');
    const { result } = renderHook(() => useConfirmarEntregaAction());

    await result.current.action.run([row('p1', '42')]);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'yellow', message: expect.stringContaining('42') }),
    );
    expect(notifyMock).not.toHaveBeenCalledWith(expect.objectContaining({ color: 'green' }));
  });

  it('confirms the valid pedidos in a mixed selection and blocks the rest', async () => {
    confirmarEntregaPedidoMock.mockImplementation((_port, { pedidoId }: { pedidoId: string }) =>
      Promise.resolve(pedidoId === 'ok' ? 'confirmado' : 'bloqueado'),
    );
    const { result } = renderHook(() => useConfirmarEntregaAction());

    await result.current.action.run([row('ok'), row('bad', '99')]);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'yellow', message: expect.stringContaining('99') }),
    );
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ color: 'green' }));
  });

  it('reports a pedido with an open reclamação/devolução by numero, never counting it as confirmed (#1322)', async () => {
    confirmarEntregaPedidoMock.mockResolvedValue('incidenteAberto');
    const { result } = renderHook(() => useConfirmarEntregaAction());

    await result.current.action.run([row('p1', '77')]);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'yellow', message: expect.stringContaining('77') }),
    );
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Incidentes') }),
    );
    expect(notifyMock).not.toHaveBeenCalledWith(expect.objectContaining({ color: 'green' }));
  });

  it('separates the estado guard from the incidente guard when both fire in one batch', async () => {
    confirmarEntregaPedidoMock.mockImplementation((_port, { pedidoId }: { pedidoId: string }) => {
      if (pedidoId === 'ok') return Promise.resolve('confirmado');
      if (pedidoId === 'estado') return Promise.resolve('bloqueado');
      return Promise.resolve('incidenteAberto');
    });
    const { result } = renderHook(() => useConfirmarEntregaAction());

    await result.current.action.run([row('ok'), row('estado', '10'), row('incidente', '20')]);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'yellow',
        message: expect.stringContaining('Em processamento ou Pago'),
      }),
    );
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Incidentes') }),
    );
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'green',
        message: expect.stringContaining('Entrega confirmada'),
      }),
    );
  });

  it('reports a genuine write failure (FirebaseError) without crashing', async () => {
    confirmarEntregaPedidoMock.mockRejectedValue(new FirebaseError('permission-denied', 'nope'));
    const { result } = renderHook(() => useConfirmarEntregaAction());

    await result.current.action.run([row('p1')]);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'red', title: 'Confirmar entrega' }),
    );
  });

  it('rethrows an unexpected (non-FirebaseError) rejection', async () => {
    confirmarEntregaPedidoMock.mockRejectedValue(new TypeError('bug'));
    const { result } = renderHook(() => useConfirmarEntregaAction());

    await expect(result.current.action.run([row('p1')])).rejects.toThrow('bug');
  });
});
