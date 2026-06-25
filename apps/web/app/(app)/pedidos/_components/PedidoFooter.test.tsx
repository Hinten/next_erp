import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import type { Pedido } from '@delfrance/schemas';
import { PedidoFooter } from './PedidoFooter';
import type { FlatItem, PedidoFormState } from './types';

// The footer reads pagamentos via useSnapshot only in edit mode (pedidoId set).
// These tests run in create mode (no pedidoId → null query), but mock the hook
// so the import graph never touches Firestore.
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => ({ data: undefined, loading: false, error: undefined }),
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

function Host() {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: { _itensFlat: [], descontoTotal: 0, freteInicial: null, itensDevolvidos: null },
  });
  // Expose the (stable) form to the test in an effect, not during render.
  useEffect(() => {
    formRef = form;
  }, [form]);
  return (
    <MantineProvider>
      <PedidoFooter
        form={form}
        db={{} as Firestore}
        canWrite
        disabled={false}
        submitLabel="Salvar"
        isSubmitting={false}
        submitError={null}
      />
    </MantineProvider>
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
