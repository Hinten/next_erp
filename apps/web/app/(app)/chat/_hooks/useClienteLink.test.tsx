import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getDocsMock } = vi.hoisted(() => ({ getDocsMock: vi.fn() }));

beforeEach(() => getDocsMock.mockReset());

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/data/clienteCollection', () => ({
  clienteCollection: { ref: () => ({ __ref: true }) },
}));
vi.mock('@delfrance/data', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/data')>();
  return { ...actual, buildQuery: (ref: unknown) => ref };
});
vi.mock('firebase/firestore', async (importActual) => {
  const actual = await importActual<typeof import('firebase/firestore')>();
  return { ...actual, getDocs: getDocsMock };
});

import { clienteUserRefCandidates, useClienteLink } from './useClienteLink';

describe('clienteUserRefCandidates', () => {
  it('returns null for an anonymous conversa (no usarioOuterRef)', () => {
    expect(clienteUserRefCandidates(null)).toBeNull();
    expect(clienteUserRefCandidates(undefined)).toBeNull();
    expect(clienteUserRefCandidates('')).toBeNull();
  });

  it('extracts the uid and yields both stored userCliente shapes', () => {
    expect(clienteUserRefCandidates('documents/usuarios/abc123')).toEqual([
      'documents/usuarios/abc123',
      'usuarios/abc123',
    ]);
  });

  it('handles a bare usuarios/<uid> ref too (idFromRef takes the last segment)', () => {
    expect(clienteUserRefCandidates('usuarios/xyz')).toEqual([
      'documents/usuarios/xyz',
      'usuarios/xyz',
    ]);
  });
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useClienteLink', () => {
  it('surfaces a query failure as "error" (never "not-found", which would offer "Criar cliente")', async () => {
    getDocsMock.mockRejectedValueOnce(new Error('permission-denied'));
    const { result } = renderHook(() => useClienteLink('documents/usuarios/abc123'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('resolves to "not-found" when the query returns no cliente', async () => {
    getDocsMock.mockResolvedValueOnce({ docs: [] });
    const { result } = renderHook(() => useClienteLink('documents/usuarios/abc123'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.status).toBe('not-found'));
  });

  it('resolves to "found" with the cliente id + nome', async () => {
    getDocsMock.mockResolvedValueOnce({
      docs: [{ id: 'cli1', data: () => ({ nome: 'Ana' }) }],
    });
    const { result } = renderHook(() => useClienteLink('documents/usuarios/abc123'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.status).toBe('found'));
    expect(result.current).toMatchObject({ status: 'found', clienteId: 'cli1', nome: 'Ana' });
  });

  it('is "no-user" for an anonymous conversa without hitting Firestore', () => {
    const { result } = renderHook(() => useClienteLink(null), { wrapper: wrapper() });
    expect(result.current.status).toBe('no-user');
    expect(getDocsMock).not.toHaveBeenCalled();
  });
});
