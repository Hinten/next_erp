import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { useAutorNome } from './useAutorNome';

const h = vi.hoisted(() => ({ getDoc: vi.fn() }));
vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  getDoc: h.getDoc,
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => db }));
const db = getFirestore(initializeApp({ projectId: 'demo-autor-gate' }, 'autor-gate'), 'default');

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
beforeEach(() => {
  h.getDoc.mockReset();
  h.getDoc.mockResolvedValue({ data: () => ({ nome: 'Ana' }) });
});

describe('useAutorNome customer reference', () => {
  it.each(['clientes/x', 'documents/clientes/x'])('reads the valid customer %j', async (ref) => {
    const { result } = renderHook(() => useAutorNome(null, ref), { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toBe('Ana'));
    expect(h.getDoc.mock.calls[0]?.[0].path).toBe('clientes/x');
    expect(h.getDoc.mock.calls[0]?.[0].converter).not.toBeNull();
  });

  it.each(['usuarios/x', 'a/b/clientes/x', 'clientes'])('rejects %j without a user id', (ref) => {
    const { result } = renderHook(() => useAutorNome(null, ref), { wrapper: wrapper() });
    expect(result.current).toBe('Anônimo');
    expect(h.getDoc).not.toHaveBeenCalled();
  });

  it('preserves the user-author fallback for an invalid customer ref', async () => {
    const { result } = renderHook(() => useAutorNome('u1', 'produtos/x'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toBe('Ana'));
    expect(h.getDoc.mock.calls[0]?.[0].path).toBe('usuarios/u1');
    expect(h.getDoc).toHaveBeenCalledOnce();
  });

  it('does not expose the old customer name after the reference becomes invalid', async () => {
    const { result, rerender } = renderHook(({ ref }) => useAutorNome(null, ref), {
      wrapper: wrapper(),
      initialProps: { ref: 'clientes/x' },
    });
    await waitFor(() => expect(result.current).toBe('Ana'));
    h.getDoc.mockClear();
    rerender({ ref: 'usuarios/x' });
    expect(result.current).toBe('Anônimo');
    expect(h.getDoc).not.toHaveBeenCalled();
  });
});
