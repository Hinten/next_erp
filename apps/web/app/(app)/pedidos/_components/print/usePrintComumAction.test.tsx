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
});
