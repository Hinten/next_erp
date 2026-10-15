import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { initializeApp, FirebaseError } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import type { Pedido } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { OrigemPedidoPicker } from './OrigemPedidoPicker';

const h = vi.hoisted(() => ({
  outerRef: null as unknown,
  getDoc: vi.fn(),
}));
vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  getDoc: h.getDoc,
}));
vi.mock('@delfrance/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/data')>()),
  buildQuery: (ref: unknown) => ref,
}));
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => ({
    loading: false,
    data: [{ id: 'p1', data: { numero: '123', clientePedidoOuterRef: h.outerRef } as Pedido }],
  }),
}));
// Eligibility is covered by devolucaoForm.test.ts; these rows exercise customer reads.
vi.mock('./devolucaoForm', () => ({ isReturnableOrigin: () => true }));
vi.mock('../rowReadPrefetch', async () => import('@/lib/data/readClienteByRef'));

const db = getFirestore(
  initializeApp({ projectId: 'demo-origem-cliente' }, 'origem-cliente'),
  'default',
);

function show(outerRef: unknown) {
  h.outerRef = outerRef;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return render(
    <MantineTestProvider>
      <QueryClientProvider client={client}>
        <OrigemPedidoPicker
          db={db}
          opened
          onClose={vi.fn()}
          excludeIds={new Set()}
          onPick={vi.fn()}
        />
      </QueryClientProvider>
    </MantineTestProvider>,
  );
}

beforeEach(() => {
  h.getDoc.mockReset();
  h.getDoc.mockResolvedValue({ data: () => ({ nome: 'Ana' }) });
});

describe('OrigemPedidoPicker customer reference', () => {
  it.each(['documents/usuarios/x', 'a/b/clientes/x', 'clientes'])(
    'rejects %j without a read',
    (ref) => {
      show(ref);
      expect(screen.getByText('Cliente não reconhecido')).toBeTruthy();
      expect(h.getDoc).not.toHaveBeenCalled();
    },
  );

  it('reserves Anônimo for an absent reference', () => {
    show(null);
    expect(screen.getByText('Anônimo')).toBeTruthy();
    expect(h.getDoc).not.toHaveBeenCalled();
  });

  it.each(['clientes/x', 'documents/clientes/x'])(
    'reads %j with the customer converter',
    async (ref) => {
      show(ref);
      await screen.findByText('Ana');
      expect(h.getDoc.mock.calls[0]?.[0].path).toBe('clientes/x');
      expect(h.getDoc.mock.calls[0]?.[0].converter).not.toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
    },
  );

  it('shows a missing cadastro instead of Anônimo', async () => {
    h.getDoc.mockResolvedValue({ data: () => undefined });
    show('clientes/x');
    await screen.findByText('Cadastro não encontrado');
    expect(screen.queryByText('Anônimo')).toBeNull();
  });

  it('shows a neutral label after a failed read', async () => {
    h.getDoc.mockRejectedValue(new FirebaseError('permission-denied', 'denied'));
    show('clientes/x');
    await screen.findByText('Cliente indisponível');
    expect(screen.queryByText('Anônimo')).toBeNull();
  });

  it('shows (sem nome) for a blank customer name', async () => {
    h.getDoc.mockResolvedValue({ data: () => ({ nome: '  ' }) });
    show('clientes/x');
    await screen.findByText('(sem nome)');
  });

  it('does not label a pending read as missing or anonymous', async () => {
    h.getDoc.mockReturnValue(new Promise<never>(() => undefined));
    const { container } = show('clientes/x');
    await waitFor(() => expect(h.getDoc).toHaveBeenCalledOnce());
    expect(container.querySelector('[class*="Skeleton"]')).toBeTruthy();
    expect(screen.queryByText('Anônimo')).toBeNull();
    expect(screen.queryByText('Cadastro não encontrado')).toBeNull();
  });
});
