import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider, Tabs } from '@mantine/core';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import type { ItemDoPedido, Pedido } from '@delfrance/schemas';
import { DevolucaoTab } from './DevolucaoTab';
import type { PedidoFormState } from '../types';

// Regression guard for #473 (parent #227): the pedido Tabs use
// `keepMounted={false}`, so switching away unmounts DevolucaoTab and drops its
// local `rows` state. The tab survives this only because `rows` is seeded from
// the react-hook-form value on mount (`editRowsFromItensDevolvidos(getValues)`)
// and synced back to it — the seed-from-form-on-mount pattern (ref: the frete
// `MelhorEnvioFields` fix, PR #210 / 53cec77). These tests unmount the tab for
// real and assert the returns re-hydrate from the form, so a future edit that
// stops seeding `rows` from the form (reintroducing the state-loss bug class)
// fails in CI instead of shipping silently.

// The pickers reach Firestore; the re-hydration guard never opens them (all
// seeded rows are origin rows with a bound produto, so no ProdutoPicker
// renders), so stub them out to keep the test offline.
vi.mock('@/components/pickers/ProdutoPicker', () => ({
  ProdutoPicker: () => null,
}));
vi.mock('./OrigemPedidoPicker', () => ({
  OrigemPedidoPicker: () => null,
}));

function item(overrides: Partial<ItemDoPedido> = {}): ItemDoPedido {
  return {
    produtoUid: 'p1',
    ordem: 1,
    nomeDeVenda: 'Produto Teste',
    sku: 'SKU1',
    precoDeVenda: 10,
    descontoUnitario: 0,
    quantidade: 2,
    custo: 4,
    ...overrides,
  } as ItemDoPedido;
}

let formRef: UseFormReturn<PedidoFormState, unknown, Pedido>;

function Host({
  initialItensDevolvidos = null,
}: {
  initialItensDevolvidos?: PedidoFormState['itensDevolvidos'];
} = {}) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: { itensDevolvidos: initialItensDevolvidos },
  });
  // Expose the (stable) form to the test in an effect, not during render.
  useEffect(() => {
    formRef = form;
  }, [form]);
  const [tab, setTab] = useState<string | null>('devolucao');
  return (
    <MantineProvider>
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="devolucao">Devolução</Tabs.Tab>
          <Tabs.Tab value="outra">Outra</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="devolucao" pt="md">
          <DevolucaoTab form={form} db={{} as Firestore} pedidoId="ped-1" />
        </Tabs.Panel>
        <Tabs.Panel value="outra" pt="md">
          Outra aba
        </Tabs.Panel>
      </Tabs>
    </MantineProvider>
  );
}

function switchTo(value: 'devolucao' | 'outra') {
  act(() => {
    fireEvent.click(screen.getByRole('tab', { name: value === 'outra' ? 'Outra' : 'Devolução' }));
  });
}

describe('DevolucaoTab — state survives a tab switch (#473)', () => {
  it('re-hydrates seeded returns after a real unmount/remount', () => {
    render(<Host initialItensDevolvidos={{ origin1: { p1: [item()] } }} />);

    // The seeded return renders (group label + product + subtotal 10 × 2).
    expect(screen.getByText('Pedido origin1')).toBeTruthy();
    expect(screen.getByText('Produto Teste')).toBeTruthy();
    expect(screen.getAllByText(/R\$\s*20,00/).length).toBeGreaterThan(0);

    // Switch away → the panel really unmounts (keepMounted={false}).
    switchTo('outra');
    expect(screen.getByText('Outra aba')).toBeTruthy();
    expect(screen.queryByText('Produto Teste')).toBeNull();

    // Switch back → rows re-seed from the form value, not from an empty init.
    switchTo('devolucao');
    expect(screen.getByText('Produto Teste')).toBeTruthy();
    expect(screen.getAllByText(/R\$\s*20,00/).length).toBeGreaterThan(0);
  });

  it('reflects a form write made while the tab is unmounted', () => {
    render(<Host />);
    // Starts with no returns.
    expect(screen.getByText(/Nenhuma devolução/)).toBeTruthy();

    // Leave the tab (unmount), then write returns straight to the form — as the
    // save/reconcile paths do — while DevolucaoTab is not mounted.
    switchTo('outra');
    act(() => {
      formRef.setValue('itensDevolvidos', {
        origin1: { p1: [item({ nomeDeVenda: 'Produto Recarregado' })] },
      });
    });

    // Coming back seeds `rows` from the current form value.
    switchTo('devolucao');
    expect(screen.getByText('Produto Recarregado')).toBeTruthy();
  });

  it('persists an in-tab quantity edit across a tab switch', () => {
    render(<Host initialItensDevolvidos={{ origin1: { p1: [item({ quantidade: 2 })] } }} />);
    expect(screen.getAllByText(/R\$\s*20,00/).length).toBeGreaterThan(0);

    // Edit the quantity in the UI (2 → 1): the row subtotal drops to 10 × 1.
    const qtyInput = screen.getByLabelText('Quantidade devolvida de Produto Teste');
    act(() => {
      fireEvent.change(qtyInput, { target: { value: '1' } });
    });
    expect(screen.getAllByText(/R\$\s*10,00/).length).toBeGreaterThan(0);

    // Switch away and back — the edit is held by the form, so it survives.
    switchTo('outra');
    switchTo('devolucao');
    expect(screen.getAllByText(/R\$\s*10,00/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/R\$\s*20,00/).length).toBe(0);
  });
});
