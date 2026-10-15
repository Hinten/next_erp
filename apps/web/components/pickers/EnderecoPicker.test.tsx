import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { EnderecoPicker, enderecoLabel } from './EnderecoPicker';

const h = vi.hoisted(() => ({ getDoc: vi.fn(), getDocs: vi.fn() }));
vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  getDoc: h.getDoc,
  getDocs: h.getDocs,
}));
vi.mock('@delfrance/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/data')>()),
  buildQuery: (ref: unknown) => ref,
}));
vi.mock('@/lib/auth', () => ({ usePermission: () => ({ allowed: true }) }));
vi.mock('./EnderecoFormModal', () => ({
  EnderecoFormModal: ({
    opened,
    clienteId,
    onSaved,
  }: {
    opened: boolean;
    clienteId: string;
    onSaved: (id: string) => void;
  }) =>
    opened ? (
      <div role="dialog" aria-label="Novo endereço">
        <span>{clienteId}</span>
        <button type="button" onClick={() => onSaved('new')}>
          Save address
        </button>
      </div>
    ) : null,
}));

const db = getFirestore(
  initializeApp({ projectId: 'demo-endereco-gate' }, 'endereco-gate'),
  'default',
);
const endereco = { logradouro: 'Rua Atual', numero: '10', cidade: 'São Paulo', estado: 'SP' };

beforeEach(() => {
  h.getDoc.mockReset();
  h.getDocs.mockReset();
  h.getDocs.mockResolvedValue({ docs: [] });
  h.getDoc.mockResolvedValue({ exists: () => true, data: () => endereco });
});

function host(client: QueryClient, cliente: unknown, value: unknown = null, onChange = vi.fn()) {
  return (
    <MantineTestProvider>
      <QueryClientProvider client={client}>
        <EnderecoPicker db={db} clienteOuterRef={cliente} value={value} onChange={onChange} />
      </QueryClientProvider>
    </MantineTestProvider>
  );
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

describe('EnderecoPicker customer gate', () => {
  it.each(['documents/usuarios/x', 'a/b/clientes/x', 'clientes', null])(
    'does not list or offer creation for %j',
    (ref) => {
      render(host(client(), ref));
      expect(h.getDocs).not.toHaveBeenCalled();
      expect(h.getDoc).not.toHaveBeenCalled();
      expect(screen.queryByText('+ Novo endereço')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it.each(['clientes/x', 'documents/clientes/x'])(
    'lists and creates an address under %j',
    async (ref) => {
      const onChange = vi.fn();
      render(host(client(), ref, null, onChange));
      await waitFor(() => expect(h.getDocs).toHaveBeenCalledOnce());
      expect(h.getDocs.mock.calls[0]?.[0].path).toBe('clientes/x/enderecos');
      fireEvent.click(screen.getByText('+ Novo endereço'));
      expect(screen.getByRole('dialog').textContent).toContain('x');
      fireEvent.click(screen.getByText('Save address'));
      expect(onChange).toHaveBeenCalledWith('documents/clientes/x/enderecos/new');
    },
  );

  it('removes the open modal and old list when the customer becomes invalid', async () => {
    const queryClient = client();
    h.getDocs.mockResolvedValue({
      docs: [
        {
          ref: { path: 'clientes/x/enderecos/a' },
          data: () => endereco,
        },
      ],
    });
    const view = render(host(queryClient, 'clientes/x'));
    await waitFor(() => expect(h.getDocs).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByText('+ Novo endereço'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    h.getDocs.mockClear();
    view.rerender(host(queryClient, 'documents/usuarios/x'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('+ Novo endereço')).toBeNull();
    expect(h.getDocs).not.toHaveBeenCalled();
    expect((screen.getByRole('combobox') as HTMLInputElement).disabled).toBe(true);
  });

  it('keeps an independently selected address visible for an invalid customer', async () => {
    render(host(client(), 'usuarios/x', 'documents/clientes/other/enderecos/a'));
    await waitFor(() =>
      expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe(
        enderecoLabel(endereco),
      ),
    );
    expect(h.getDoc.mock.calls[0]?.[0].path).toBe('clientes/other/enderecos/a');
    expect(h.getDocs).not.toHaveBeenCalled();
    expect(screen.queryByText('+ Novo endereço')).toBeNull();
  });
});
