import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Pedido } from '@delfrance/schemas';

import { usePrintComumAction } from './usePrintComumAction';

function row(id: string, foiImpresso: boolean) {
  return { id, path: `pedidos/${id}`, data: { foiImpresso } as Pedido };
}

describe('usePrintComumAction', () => {
  it('opens the modal and counts already-printed pedidos', () => {
    const { result } = renderHook(() => usePrintComumAction());

    act(() => {
      void result.current.action.run([row('a', true), row('b', false), row('c', true)]);
    });

    expect(result.current.printModal.opened).toBe(true);
    expect(result.current.printModal.pedidoIds).toEqual(['a', 'b', 'c']);
    expect(result.current.printModal.alreadyPrintedCount).toBe(2);
  });

  it('reports zero when none were printed', () => {
    const { result } = renderHook(() => usePrintComumAction());
    act(() => {
      void result.current.action.run([row('a', false), row('b', false)]);
    });
    expect(result.current.printModal.alreadyPrintedCount).toBe(0);
  });

  it('counts pedidos printed via dtImpressao when foiImpresso is not projected', () => {
    // The /pedidos TableView projects only column fields, so `foiImpresso` is
    // often absent; `dtImpressao` (the "Imp." column) is the reliable signal.
    const { result } = renderHook(() => usePrintComumAction());
    act(() => {
      void result.current.action.run([
        { id: 'a', path: 'pedidos/a', data: { dtImpressao: 1_700_000_000_000_000 } as Pedido },
        { id: 'b', path: 'pedidos/b', data: {} as Pedido },
      ]);
    });
    expect(result.current.printModal.alreadyPrintedCount).toBe(1);
  });
});
