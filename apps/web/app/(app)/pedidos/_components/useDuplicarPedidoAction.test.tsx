import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

import { useDuplicarPedidoAction } from './useDuplicarPedidoAction';

describe('useDuplicarPedidoAction', () => {
  it('exposes a single-selection Duplicar action', () => {
    const { result } = renderHook(() => useDuplicarPedidoAction('saida'));
    expect(result.current.action.id).toBe('duplicar-pedido');
    expect(result.current.action.label).toBe('Duplicar');
    expect(result.current.action.requiresSelection).toBe(true);
    expect(result.current.action.maxSelection).toBe(1);
  });

  it('navigates to the saída create route with ?copiarDe=<id>', () => {
    const { result } = renderHook(() => useDuplicarPedidoAction('saida'));
    void result.current.action.run([{ id: 'p1', data: {} }] as never);
    expect(push).toHaveBeenCalledWith('/pedidos/novo?copiarDe=p1');
  });

  it('navigates to the entrada create route with ?copiarDe=<id>', () => {
    push.mockClear();
    const { result } = renderHook(() => useDuplicarPedidoAction('entrada'));
    void result.current.action.run([{ id: 'p2', data: {} }] as never);
    expect(push).toHaveBeenCalledWith('/pedidos/entradas/novo?copiarDe=p2');
  });

  it('no-ops when run with no rows', () => {
    push.mockClear();
    const { result } = renderHook(() => useDuplicarPedidoAction('saida'));
    void result.current.action.run([]);
    expect(push).not.toHaveBeenCalled();
  });
});
