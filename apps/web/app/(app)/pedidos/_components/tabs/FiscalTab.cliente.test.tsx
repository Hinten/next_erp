import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Pedido } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { PedidoFormState } from '../types';
import { FiscalTab } from './FiscalTab';

const h = vi.hoisted(() => ({
  snapshot: {
    data: undefined as { id: string; data: { nome: string; cpf_cnpj: string } } | null | undefined,
    documentPath: undefined as string | undefined,
    loading: false,
  },
  subscribe: vi.fn(),
}));
vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: (ref: unknown) => {
    h.subscribe(ref);
    return h.snapshot;
  },
}));
vi.mock('@/components/pickers/EnderecoPicker', () => ({ EnderecoPicker: () => null }));
vi.mock('./ReferenciaPorItemSection', () => ({
  ReferenciaPorItemSection: ({
    destinatarioDocumento,
  }: {
    destinatarioDocumento: string | null;
  }) => <div data-testid="destinatario">{destinatarioDocumento ?? ''}</div>,
}));
vi.mock('./AjusteRtcSection', () => ({ AjusteRtcSection: () => null }));

const db = getFirestore(
  initializeApp({ projectId: 'demo-fiscal-cliente' }, 'fiscal-cliente'),
  'default',
);
let formRef: UseFormReturn<PedidoFormState, unknown, Pedido>;
function Host({ clienteRef }: { clienteRef: string | null }) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: { clientePedidoOuterRef: clienteRef, enderecoFiscalOuterRef: null },
  });
  useEffect(() => {
    formRef = form;
  }, [form]);
  return (
    <MantineTestProvider>
      <FiscalTab form={form} db={db} />
    </MantineTestProvider>
  );
}
beforeEach(() => {
  h.subscribe.mockClear();
  h.snapshot.data = undefined;
  h.snapshot.documentPath = undefined;
  h.snapshot.loading = false;
});
function loadedCustomer() {
  h.snapshot.data = { id: 'x', data: { nome: 'Ana', cpf_cnpj: '12345678901' } };
  h.snapshot.documentPath = 'clientes/x';
}

describe('FiscalTab customer gate and address guidance', () => {
  it.each(['usuarios/x', 'a/b/clientes/x', 'clientes', null])(
    'does not subscribe to a customer for %j',
    (ref) => {
      loadedCustomer();
      render(<Host clienteRef={ref} />);
      expect(h.subscribe).toHaveBeenCalledWith(null);
      expect(h.subscribe.mock.calls.every(([target]) => target === null)).toBe(true);
      expect(screen.getByTestId('destinatario').textContent).toBe('');
      expect(
        screen.getByText(
          'Selecione um cliente na aba Principal e depois um endereço fiscal dele, obrigatório para emitir a NF-e.',
        ),
      ).toBeTruthy();
    },
  );

  it.each(['clientes/x', 'documents/clientes/x'])(
    'uses the loaded customer at %j and requires choosing an address',
    (ref) => {
      loadedCustomer();
      render(<Host clienteRef={ref} />);
      expect(h.subscribe.mock.calls[0]?.[0].path).toBe('clientes/x');
      expect(h.subscribe.mock.calls[0]?.[0].converter).not.toBeNull();
      expect(screen.getByTestId('destinatario').textContent).toBe('12345678901');
      expect(screen.getByText(/Sem endereço fiscal definido/).textContent).toBe(
        'Sem endereço fiscal definido. A emissão da NF-e exige um endereço fiscal. Selecione um endereço do cliente Ana.',
      );
    },
  );

  it.each(['clientes/y', 'usuarios/x'])(
    'rejects the previous snapshot after changing to %j',
    (nextRef) => {
      loadedCustomer();
      render(<Host clienteRef="clientes/x" />);
      expect(screen.getByTestId('destinatario').textContent).toBe('12345678901');
      act(() => formRef.setValue('clientePedidoOuterRef', nextRef));
      expect(screen.getByTestId('destinatario').textContent).toBe('');
      expect(screen.queryByText('Ana')).toBeNull();
    },
  );

  it('never promises an inferred or inherited address', () => {
    render(<Host clienteRef={null} />);
    expect(screen.queryByText(/inferid|herdar/i)).toBeNull();
  });
});
