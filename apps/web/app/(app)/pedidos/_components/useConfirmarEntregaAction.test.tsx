import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ESTADO_FRETE, ESTADO_PEDIDO, MODALIDADE_FRETE, type Pedido } from '@delfrance/schemas';

const { docs, mergeMock, notifyMock } = vi.hoisted(() => ({
  docs: { current: new Map<string, Pedido>() },
  mergeMock: vi.fn().mockResolvedValue(undefined),
  notifyMock: vi.fn(),
}));

vi.mock('@/lib/data/getDocsByIds', () => ({
  getDocsByIds: vi.fn().mockImplementation(async () => docs.current),
}));
vi.mock('@/lib/data/pedidoCollection', () => ({
  pedidoCollection: { merge: mergeMock },
}));
vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: () => ({}),
}));
vi.mock('@mantine/notifications', () => ({
  notifications: { show: notifyMock },
}));

import { useConfirmarEntregaAction } from './useConfirmarEntregaAction';

/** Minimal pedido fixture — only the fields the action reads. */
function pedido(over: Partial<Pedido> = {}): Pedido {
  return {
    estado: ESTADO_PEDIDO.pago,
    ehSaida: true,
    freteInicial: null,
    numero: null,
    ...over,
  } as Pedido;
}

describe('useConfirmarEntregaAction', () => {
  beforeEach(() => {
    docs.current = new Map();
    mergeMock.mockClear().mockResolvedValue(undefined);
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
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it('marks freteInicial.estado=entregue and estado=finalizado for an emProcessamento pedido', async () => {
    docs.current = new Map([['p1', pedido({ estado: ESTADO_PEDIDO.emProcessamento })]]);
    const { result } = renderHook(() => useConfirmarEntregaAction());

    await result.current.action.run([{ id: 'p1', data: pedido() }] as never);

    expect(mergeMock).toHaveBeenCalledTimes(1);
    expect(mergeMock).toHaveBeenCalledWith(
      {},
      {},
      'p1',
      expect.objectContaining({
        estado: ESTADO_PEDIDO.finalizado,
        freteInicial: expect.objectContaining({ estado: ESTADO_FRETE.entregue }),
      }),
    );
  });

  it('synthesizes a semFrete (sem transporte) block when freteInicial is null', async () => {
    docs.current = new Map([
      ['p1', pedido({ estado: ESTADO_PEDIDO.pago, freteInicial: null, ehSaida: true })],
    ]);
    const { result } = renderHook(() => useConfirmarEntregaAction());

    await result.current.action.run([{ id: 'p1', data: pedido() }] as never);

    const patch = mergeMock.mock.calls[0]![3] as { freteInicial: { modalidade: string } };
    expect(patch.freteInicial.modalidade).toBe(MODALIDADE_FRETE.semTransporte);
  });

  it('preserves the rest of an existing freteInicial block, only moving estado', async () => {
    docs.current = new Map([
      [
        'p1',
        pedido({
          estado: ESTADO_PEDIDO.pago,
          freteInicial: {
            estado: ESTADO_FRETE.aCaminho,
            modalidade: MODALIDADE_FRETE.fob,
            codRastreio: 'BR123',
          } as Pedido['freteInicial'],
        }),
      ],
    ]);
    const { result } = renderHook(() => useConfirmarEntregaAction());

    await result.current.action.run([{ id: 'p1', data: pedido() }] as never);

    const patch = mergeMock.mock.calls[0]![3] as {
      freteInicial: { estado: string; codRastreio: string };
    };
    expect(patch.freteInicial.estado).toBe(ESTADO_FRETE.entregue);
    expect(patch.freteInicial.codRastreio).toBe('BR123');
  });

  it('blocks a pedido whose estado is not emProcessamento/pago, without writing', async () => {
    docs.current = new Map([['p1', pedido({ estado: ESTADO_PEDIDO.cancelado, numero: '42' })]]);
    const { result } = renderHook(() => useConfirmarEntregaAction());

    await result.current.action.run([{ id: 'p1', data: pedido() }] as never);

    expect(mergeMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'yellow', message: expect.stringContaining('42') }),
    );
  });

  it('confirms the valid pedidos in a mixed selection and blocks the rest', async () => {
    docs.current = new Map([
      ['ok', pedido({ estado: ESTADO_PEDIDO.pago })],
      ['bad', pedido({ estado: ESTADO_PEDIDO.fraude, numero: '99' })],
    ]);
    const { result } = renderHook(() => useConfirmarEntregaAction());

    await result.current.action.run([
      { id: 'ok', data: pedido() },
      { id: 'bad', data: pedido() },
    ] as never);

    expect(mergeMock).toHaveBeenCalledTimes(1);
    expect(mergeMock).toHaveBeenCalledWith({}, {}, 'ok', expect.anything());
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'yellow', message: expect.stringContaining('99') }),
    );
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ color: 'green' }));
  });
});
