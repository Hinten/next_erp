import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Tabs } from '@mantine/core';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import type { Pedido } from '@delfrance/schemas';
import { PrincipalTab } from './PrincipalTab';
import type { FlatItem, PedidoFormState } from '../types';

// Regression guard for #470 (parent #227): PedidoForm Tabs use
// `keepMounted={false}`, so switching away unmounts PrincipalTab. Form fields
// must live in react-hook-form (or be reconstructable from it) — otherwise
// in-progress item edits vanish. PrincipalTab already has no form-data
// useState; these tests unmount the panel for real and assert item + notes
// values re-hydrate from the form so a future edit that reintroduces local
// state fails in CI (same harness as FiscalTab #471 / DevolucaoTab #473).

// Firestore-touching bits are not under test — stub them offline.
vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: () => ({ data: undefined, loading: false, error: undefined }),
}));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: () => null,
}));
vi.mock('@/lib/data/listaDePrecosCollection', () => ({
  listaDePrecosCollection: { docRef: () => ({}) },
}));
vi.mock('@/lib/data/integracaoCollection', () => ({
  integracaoCollection: { docRef: () => ({}) },
}));
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: { docRef: () => ({}) },
}));
vi.mock('../useEstoqueDisponivel', () => ({
  useEstoqueDisponivel: () => null,
}));
vi.mock('@/components/ProdutoThumbnail', () => ({
  ProdutoThumbnail: () => null,
}));
vi.mock('../ProdutoVariacaoLabel', () => ({
  ProdutoVariacaoLabel: () => null,
}));

// Pickers only need to surface the form value and accept onChange; they must
// not hit Firestore. Cliente is form-backed like the item fields.
vi.mock('@/components/pickers/ClientePicker', () => ({
  ClientePicker: ({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) => (
    <div>
      <div data-testid="cliente-picker">{String(value ?? '')}</div>
      <button type="button" onClick={() => onChange('documents/clientes/c1')}>
        Definir cliente
      </button>
    </div>
  ),
}));
vi.mock('@/components/pickers/OperacaoPicker', () => ({
  OperacaoPicker: () => <div data-testid="operacao-picker" />,
}));
vi.mock('@/components/pickers/IntegracaoPicker', () => ({
  IntegracaoPicker: () => <div data-testid="integracao-picker" />,
}));
vi.mock('@/components/pickers/ListaDePrecosPicker', () => ({
  ListaDePrecosPicker: () => <div data-testid="lista-picker" />,
}));
// Empty rows mount ProdutoPicker; seeded rows with produtoUid do not.
vi.mock('@/components/pickers/ProdutoPicker', () => ({
  ProdutoPicker: () => <div data-testid="produto-picker" />,
}));

function seededItem(overrides: Partial<FlatItem> = {}): FlatItem {
  return {
    _rowId: 'row-1',
    _delete: false,
    produtoUid: 'prod-1',
    ordem: 1,
    ensureUniqueId: null,
    mktplaceId: null,
    sku: 'SKU-1',
    gtin: null,
    nomeDeVenda: 'Produto Seed',
    precoDeVenda: 10,
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
  initialItens = [seededItem()],
}: {
  initialItens?: FlatItem[];
} = {}) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: {
      ehSaida: true,
      _itensFlat: initialItens,
      observacoesInternas: null,
      clientePedidoOuterRef: null,
      operacaoPedidoOuterRef: null,
      integracaoPedidoOuterRef: null,
      listaDePrecosOuterRef: null,
    },
  });
  useEffect(() => {
    formRef = form;
  }, [form]);
  const [tab, setTab] = useState<string | null>('principal');
  return (
    <MantineTestProvider>
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="principal">Principal</Tabs.Tab>
          <Tabs.Tab value="outra">Outra</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="principal" pt="md">
          <PrincipalTab form={form} db={{} as Firestore} />
        </Tabs.Panel>
        <Tabs.Panel value="outra" pt="md">
          Outra aba
        </Tabs.Panel>
      </Tabs>
    </MantineTestProvider>
  );
}

function switchTo(value: 'principal' | 'outra') {
  act(() => {
    fireEvent.click(screen.getByRole('tab', { name: value === 'outra' ? 'Outra' : 'Principal' }));
  });
}

const qtyInput = () => screen.getByLabelText('Quantidade item 1') as HTMLInputElement;
const precoInput = () => screen.getByLabelText('Preço item 1') as HTMLInputElement;
const descontoInput = () => screen.getByLabelText('Desconto item 1') as HTMLInputElement;
const obsField = () => screen.getByLabelText(/Observações internas/) as HTMLTextAreaElement;

describe('PrincipalTab — state survives a tab switch (#470)', () => {
  it('keeps item qty/price/discount and notes after unmount/remount', () => {
    render(<Host />);

    // Edit every operator-owned Principal field that is form-backed.
    fireEvent.change(qtyInput(), { target: { value: '3' } });
    fireEvent.change(precoInput(), { target: { value: '25,50' } });
    fireEvent.change(descontoInput(), { target: { value: '1,00' } });
    fireEvent.change(obsField(), { target: { value: 'Nota interna de teste' } });
    fireEvent.click(screen.getByRole('button', { name: 'Definir cliente' }));

    expect(formRef.getValues('_itensFlat.0.quantidade')).toBe(3);
    expect(formRef.getValues('_itensFlat.0.precoDeVenda')).toBe(25.5);
    expect(formRef.getValues('_itensFlat.0.descontoUnitario')).toBe(1);
    expect(formRef.getValues('observacoesInternas')).toBe('Nota interna de teste');
    expect(formRef.getValues('clientePedidoOuterRef')).toBe('documents/clientes/c1');

    // Switch away — keepMounted={false} unmounts PrincipalTab entirely.
    switchTo('outra');
    expect(screen.getByText('Outra aba')).toBeTruthy();
    expect(screen.queryByLabelText('Quantidade item 1')).toBeNull();

    // Switch back — remount must re-hydrate from the form, not empty defaults.
    switchTo('principal');
    // Mantine NumberInput may trim trailing zeros in the displayed string
    // ("25,5" not "25,50"); assert form numbers + loose UI match.
    expect(formRef.getValues('_itensFlat.0.quantidade')).toBe(3);
    expect(formRef.getValues('_itensFlat.0.precoDeVenda')).toBe(25.5);
    expect(formRef.getValues('_itensFlat.0.descontoUnitario')).toBe(1);
    expect(qtyInput().value).toMatch(/3/);
    expect(precoInput().value).toMatch(/25[,.]5/);
    expect(descontoInput().value).toMatch(/1/);
    expect(obsField().value).toBe('Nota interna de teste');
    expect(screen.getByTestId('cliente-picker').textContent).toBe('documents/clientes/c1');
    expect(screen.getByText('Produto Seed')).toBeTruthy();
  });

  it('keeps staged item delete (_delete) after unmount/remount', () => {
    render(<Host />);
    expect(screen.queryByText('Será excluída')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remover item' }));
    expect(formRef.getValues('_itensFlat.0._delete')).toBe(true);
    expect(screen.getByText('Será excluída')).toBeTruthy();

    switchTo('outra');
    switchTo('principal');

    expect(formRef.getValues('_itensFlat.0._delete')).toBe(true);
    expect(screen.getByText('Será excluída')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Desfazer remoção' })).toBeTruthy();
  });

  it('re-hydrates an item write made while the tab is unmounted', () => {
    render(<Host />);
    expect(qtyInput().value).toMatch(/1/);

    switchTo('outra');
    act(() => {
      formRef.setValue('_itensFlat', [
        seededItem({
          quantidade: 7,
          precoDeVenda: 99.9,
          nomeDeVenda: 'Produto Recarregado',
        }),
      ]);
    });

    switchTo('principal');
    expect(formRef.getValues('_itensFlat.0.quantidade')).toBe(7);
    expect(formRef.getValues('_itensFlat.0.precoDeVenda')).toBe(99.9);
    expect(qtyInput().value).toMatch(/7/);
    expect(precoInput().value).toMatch(/99[,.]9/);
    expect(screen.getByText('Produto Recarregado')).toBeTruthy();
  });
});
