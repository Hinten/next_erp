import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getDocsMock, getDocMock } = vi.hoisted(() => ({
  getDocsMock: vi.fn(),
  getDocMock: vi.fn(),
}));

beforeEach(() => {
  getDocsMock.mockReset();
  getDocMock.mockReset();
});

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/data/clienteCollection', () => ({
  clienteCollection: {
    ref: () => ({ __ref: true }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ __docRef: id }),
  },
}));
vi.mock('@delfrance/data', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/data')>();
  return { ...actual, buildQuery: (ref: unknown) => ref };
});
vi.mock('firebase/firestore', async (importActual) => {
  const actual = await importActual<typeof import('firebase/firestore')>();
  return { ...actual, getDocs: getDocsMock, getDoc: getDocMock };
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
    const { result } = renderHook(() => useClienteLink(null, 'documents/usuarios/abc123'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('resolves to "not-found" when the query returns no cliente', async () => {
    getDocsMock.mockResolvedValueOnce({ docs: [] });
    const { result } = renderHook(() => useClienteLink(null, 'documents/usuarios/abc123'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.status).toBe('not-found'));
  });

  it('resolves to "found" with the cliente id + nome', async () => {
    getDocsMock.mockResolvedValueOnce({
      docs: [{ id: 'cli1', data: () => ({ nome: 'Ana' }) }],
    });
    const { result } = renderHook(() => useClienteLink(null, 'documents/usuarios/abc123'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.status).toBe('found'));
    expect(result.current).toMatchObject({ status: 'found', clienteId: 'cli1', nome: 'Ana' });
  });

  it('is "no-user" for an anonymous conversa without hitting Firestore', () => {
    const { result } = renderHook(() => useClienteLink(null, null), { wrapper: wrapper() });
    expect(result.current.status).toBe('no-user');
    expect(getDocsMock).not.toHaveBeenCalled();
  });
});

describe('useClienteLink — the direct clienteOuterRef path', () => {
  it('reads the cliente doc directly, with no usuarios hop and no query', async () => {
    getDocMock.mockResolvedValueOnce({
      exists: () => true,
      id: 'cli9',
      data: () => ({ nome: 'Bia' }),
    });
    const { result } = renderHook(() => useClienteLink('documents/clientes/cli9', null), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.status).toBe('found'));
    expect(result.current).toMatchObject({ status: 'found', clienteId: 'cli9', nome: 'Bia' });
    // A getDoc, not a where(...in...) — so this path needs no composite index.
    expect(getDocsMock).not.toHaveBeenCalled();
  });

  it('PREFERS the direct ref when a doc carries both fields', async () => {
    // Not hypothetical, and the reason the order matters: ML conversa doc ids
    // are byte-exact legacy digests, so the first post-cutover redelivery
    // `merge()`s onto the Flutter-written doc — and a merge does not clear
    // `usarioOuterRef`. Those docs carry both, and only the direct ref is right.
    getDocMock.mockResolvedValueOnce({
      exists: () => true,
      id: 'cli9',
      data: () => ({ nome: 'Bia' }),
    });
    const { result } = renderHook(
      () => useClienteLink('documents/clientes/cli9', 'documents/usuarios/abc123'),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.status).toBe('found'));
    expect(result.current).toMatchObject({ clienteId: 'cli9' });
    expect(getDocsMock).not.toHaveBeenCalled();
  });

  it('is "not-found" when the direct ref dangles', async () => {
    getDocMock.mockResolvedValueOnce({ exists: () => false });
    const { result } = renderHook(() => useClienteLink('documents/clientes/gone', null), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.status).toBe('not-found'));
  });

  it('still falls back to the usuarios hop for a legacy conversa', async () => {
    getDocsMock.mockResolvedValueOnce({ docs: [{ id: 'cli1', data: () => ({ nome: 'Ana' }) }] });
    const { result } = renderHook(() => useClienteLink(null, 'documents/usuarios/abc123'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.status).toBe('found'));
    expect(result.current).toMatchObject({ clienteId: 'cli1' });
    expect(getDocMock).not.toHaveBeenCalled();
  });
});
