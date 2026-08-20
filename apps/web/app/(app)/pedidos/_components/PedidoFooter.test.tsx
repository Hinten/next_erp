import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import type { Pedido } from '@delfrance/schemas';
import { PedidoFooter } from './PedidoFooter';
import type { FlatItem, PedidoFormState } from './types';

// The footer reads pagamentos via useSnapshot. Mock the hook (no data) plus the
// query builders / collection handle so building the query with a fake db never
// touches Firestore — even in the edit-mode case where pedidoId is set.
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => ({ data: undefined, loading: false, error: undefined }),
}));
vi.mock('@delfrance/data', () => ({
  buildQuery: () => ({}),
  orderByField: () => ({}),
}));
vi.mock('@/lib/data/pagamentoCollection', () => ({
  pagamentoCollection: { ref: () => ({}) },
}));

function item(overrides: Partial<FlatItem> = {}): FlatItem {
  return {
    _rowId: 'row-1',
    _delete: false,
    produtoUid: 'prod-1',
    ordem: 1,
    mktplaceId: null,
    sku: null,
    gtin: null,
    nomeDeVenda: 'Item',
    precoDeVenda: 33.5,
    descontoUnitario: 0,
    quantidade: 1,
    custo: null,
    timestamp: null,
    imposto: null,
    ...overrides,
  } as FlatItem;
}

let formRef: UseFormReturn<PedidoFormState, unknown, Pedido>;

function Host({
  pedidoId,
  onSaveAndContinue,
  ehSaida,
}: {
  pedidoId?: string;
  onSaveAndContinue?: () => void;
  ehSaida?: boolean;
} = {}) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: { _itensFlat: [], descontoTotal: 0, freteInicial: null, itensDevolvidos: null },
  });
  // Expose the (stable) form to the test in an effect, not during render.
  useEffect(() => {
    formRef = form;
  }, [form]);
  return (
    <MantineTestProvider>
      <PedidoFooter
        form={form}
        db={{} as Firestore}
        pedidoId={pedidoId}
        canWrite
        disabled={false}
        submitLabel="Salvar"
        isSubmitting={false}
        submitError={null}
        ehSaida={ehSaida}
        onSaveAndContinue={onSaveAndContinue}
      />
    </MantineTestProvider>
  );
}

describe('PedidoFooter — live total reactivity', () => {
  it('re-derives the total when items change after the initial render', () => {
    render(<Host />);
    // Starts empty → R$ 0,00.
    expect(screen.getByTestId('footer-total').textContent).toContain('0,00');

    // Add a priced item the way the Principal tab does (setValue, no parent
    // re-render). With `form.watch` the footer would stay frozen at 0,00; with
    // `useWatch` it subscribes and re-renders.
    act(() => {
      formRef.setValue('_itensFlat', [item()]);
    });
    expect(screen.getByTestId('footer-total').textContent).toContain('33,50');

    // Edit the row (qty 2, desconto 1,50) → (33,50 − 1,50) × 2 = R$ 64,00.
    act(() => {
      formRef.setValue('_itensFlat', [item({ quantidade: 2, descontoUnitario: 1.5 })]);
    });
    expect(screen.getByTestId('footer-total').textContent).toContain('64,00');
  });

  it('drops staged-deleted and in-progress rows from the total', () => {
    render(<Host />);
    act(() => {
      formRef.setValue('_itensFlat', [
        item({ _rowId: 'a', precoDeVenda: 10, quantidade: 1 }),
        item({ _rowId: 'b', _delete: true, precoDeVenda: 999, quantidade: 1 }),
        item({
          _rowId: 'c',
          produtoUid: null,
          mktplaceId: null,
          precoDeVenda: 0.01,
          quantidade: 1,
        }),
      ]);
    });
    // Only the first row counts → R$ 10,00.
    expect(screen.getByTestId('footer-total').textContent).toContain('10,00');
  });
});

describe('PedidoFooter — fields and actions', () => {
  it('always shows the Devoluções field, even at zero', () => {
    render(<Host />);
    expect(screen.getByText('Devoluções')).toBeTruthy();
    // It renders its R$ 0,00 value alongside the label.
    expect(screen.getAllByText(/R\$\s*0,00/).length).toBeGreaterThan(0);
  });

  it('shows Vlr. Pago only in edit mode, but there even at zero', () => {
    // Create mode (no pedidoId) → no payments concept → hidden.
    const { unmount } = render(<Host />);
    expect(screen.queryByText('Vlr. Pago')).toBeNull();
    unmount();

    // Edit mode → visible even at R$ 0,00.
    render(<Host pedidoId="ped-1" />);
    expect(screen.getByText('Vlr. Pago')).toBeTruthy();
  });

  it('renders the share-orçamento button on a saída (default)', () => {
    render(<Host />);
    expect(screen.getByLabelText('Compartilhar orçamento')).toBeTruthy();
  });

  it('hides the share-orçamento button on an entrada', () => {
    // An orçamento (quote) is a sale-side artifact — it has no meaning for an
    // inbound entrada (purchase / return), so the menu must not render.
    render(<Host ehSaida={false} />);
    expect(screen.queryByLabelText('Compartilhar orçamento')).toBeNull();
  });

  it('shows "Salvar e continuar editando" only in edit mode (pedidoId + handler)', () => {
    const { unmount } = render(<Host />);
    expect(screen.queryByRole('button', { name: 'Salvar e continuar editando' })).toBeNull();
    unmount();

    render(<Host pedidoId="ped-1" onSaveAndContinue={() => {}} />);
    expect(screen.getByRole('button', { name: 'Salvar e continuar editando' })).toBeTruthy();
  });
});
