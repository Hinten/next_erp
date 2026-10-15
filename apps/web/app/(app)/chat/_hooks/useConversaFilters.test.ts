import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { useConversaFilters } from './useConversaFilters';

afterEach(cleanup);

describe('chat filter URL transitions', () => {
  it('selects and clears a cliente without losing the thread path or adding history', () => {
    window.history.replaceState(null, '', '/chat/thread?tab=pendentes&etiqueta=3#message');
    const historyLength = window.history.length;
    const { result, rerender } = renderHook(useConversaFilters);

    act(() => result.current.setCliente('documents/clientes/empty'));
    rerender();
    expect(result.current.clienteRef).toBe('documents/clientes/empty');
    expect(result.current.tab).toBe('todas');
    expect(result.current.etiqueta).toBeNull();
    expect(window.location.pathname).toBe('/chat/thread');
    expect(window.location.hash).toBe('#message');
    expect(window.history.length).toBe(historyLength);

    act(() => result.current.setCliente(null));
    rerender();
    expect(result.current.clienteRef).toBeNull();
    expect(result.current.tab).toBe('todas');
    expect(window.location.search).toBe('?tab=todas');
  });

  it('composes changes made before the URL reader renders again', () => {
    window.history.replaceState(null, '', '/chat?tab=pendentes&etiqueta=3');
    const { result, rerender } = renderHook(useConversaFilters);

    act(() => {
      result.current.setCliente('documents/clientes/empty');
      result.current.setBusca('');
    });
    rerender();
    expect(result.current.clienteRef).toBe('documents/clientes/empty');
    expect(result.current.tab).toBe('todas');
    expect(result.current.etiqueta).toBeNull();
    expect(result.current.busca).toBe('');
  });

  it('clears the cliente when a consecutive change adds an exclusive filter', () => {
    window.history.replaceState(null, '', '/chat?tab=pendentes');
    const { result, rerender } = renderHook(useConversaFilters);

    act(() => {
      result.current.setCliente('documents/clientes/empty');
      result.current.setEtiqueta(3);
    });
    rerender();
    expect(result.current.clienteRef).toBeNull();
    expect(result.current.tab).toBe('todas');
    expect(result.current.etiqueta).toBe(3);
  });
});
