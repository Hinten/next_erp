import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import type { Pedido } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { FlatItem, PedidoFormState } from '../types';

// An item line names what was sold from TWO sources — the live produto doc and
// the denormalised snapshot on the item itself — and the interesting cases are
// the ones where the first is unavailable. `PrincipalTab.test.tsx` pins
// `useDocSnapshot` to a single state for the whole file, so the per-state
// control lives here.

// The produto ref carries its id so the snapshot mock can tell a produto lookup
// apart from the integração / lista ones.
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: {
    docRef: (_db: unknown, _parent: unknown, id: string) => ({ produtoId: id }),
  },
}));

// `fromCache` is part of the state on purpose: an empty emission served from the
// IndexedDB cache is not evidence of a deletion, and a stub that cannot express
// the difference cannot pin the badge.
let produtoSnapshot: {
  data: unknown;
  loading: boolean;
  error: undefined;
  fromCache?: boolean;
} = {
  data: undefined,
  loading: true,
  error: undefined,
};
vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: (ref: { produtoId?: string } | null) =>
    ref?.produtoId ? produtoSnapshot : { data: undefined, loading: false, error: undefined },
}));

vi.mock('@/lib/data/dereferenceOuterRef', () => ({ dereferenceOuterRef: () => null }));
vi.mock('@/lib/data/listaDePrecosCollection', () => ({
  listaDePrecosCollection: { docRef: () => ({}) },
}));
vi.mock('@/lib/data/integracaoCollection', () => ({
  integracaoCollection: { docRef: () => ({}) },
}));
vi.mock('../useEstoqueDisponivel', () => ({ useEstoqueDisponivel: () => null }));
vi.mock('@/components/ProdutoThumbnail', () => ({ ProdutoThumbnail: () => null }));
vi.mock('../ProdutoVariacaoLabel', () => ({ ProdutoVariacaoLabel: () => null }));
vi.mock('../VendedorField', () => ({ VendedorField: () => null }));
vi.mock('@/components/pickers/ClientePicker', () => ({ ClientePicker: () => null }));
vi.mock('@/components/pickers/OperacaoPicker', () => ({ OperacaoPicker: () => null }));
vi.mock('@/components/pickers/IntegracaoPicker', () => ({ IntegracaoPicker: () => null }));
vi.mock('@/components/pickers/ListaDePrecosPicker', () => ({ ListaDePrecosPicker: () => null }));
// The picker's placeholder is how a bound-to-nothing row says WHY it is empty.
vi.mock('@/components/pickers/ProdutoPicker', () => ({
  ProdutoPicker: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="produto-picker">{placeholder}</div>
  ),
}));

// Import AFTER the mocks are registered.
import { PrincipalTab } from './PrincipalTab';

function item(overrides: Partial<FlatItem> = {}): FlatItem {
  return {
    _rowId: 'row-1',
    _delete: false,
    produtoUid: null,
    ordem: 1,
    ensureUniqueId: null,
    mktplaceId: null,
    sku: null,
    gtin: null,
    nomeDeVenda: null,
    precoDeVenda: 10,
    descontoUnitario: 0,
    quantidade: 1,
    custo: null,
    timestamp: null,
    imposto: null,
    ...overrides,
  } as FlatItem;
}

function Host({ itens }: { itens: FlatItem[] }) {
  const form: UseFormReturn<PedidoFormState, unknown, Pedido> = useForm<
    PedidoFormState,
    unknown,
    Pedido
  >({
    defaultValues: {
      ehSaida: true,
      _itensFlat: itens,
      observacoesInternas: null,
      vendedorPedidoOuterRef: null,
      clientePedidoOuterRef: null,
      operacaoPedidoOuterRef: null,
      integracaoPedidoOuterRef: null,
      listaDePrecosOuterRef: null,
    },
  });
  return (
    <MantineTestProvider>
      <PrincipalTab form={form} db={{} as Firestore} />
    </MantineTestProvider>
  );
}

function renderLinha(itens: FlatItem[]) {
  return render(<Host itens={itens} />);
}

beforeEach(() => {
  produtoSnapshot = { data: undefined, loading: true, error: undefined };
});

describe('item row — the produto is not registered here (produtoUid: null)', () => {
  // The reported bug: a Mercado Livre / Shopee line that matched no ERP produto
  // rendered ONLY an empty search box. Everything the importer stored about it
  // was on the document and none of it reached the screen.
  it('names the item from its stored snapshot and says why it is unbound', () => {
    renderLinha([item({ nomeDeVenda: 'Camiseta Preta M', sku: 'MLB-4471', mktplaceId: 'MLB999' })]);

    expect(screen.getByText('Camiseta Preta M')).toBeTruthy();
    expect(screen.getByText('Não cadastrado')).toBeTruthy();
    expect(screen.getByText(/SKU: MLB-4471/)).toBeTruthy();
    expect(screen.getByText(/Anúncio: MLB999/)).toBeTruthy();
    // Still bindable — the panel replaces nothing, it explains the empty picker.
    expect(screen.getByTestId('produto-picker').textContent).toBe('Vincular produto…');
  });

  it('falls back to a GTIN-only line rather than rendering it blank', () => {
    renderLinha([item({ gtin: '7891234567895' })]);
    expect(screen.getByText('Produto sem nome')).toBeTruthy();
    expect(screen.getByText(/GTIN: 7891234567895/)).toBeTruthy();
  });

  // The title and the identifier line are resolved by the SAME chain, so a line
  // whose only human-readable field is the SKU titles itself with it rather than
  // with the placeholder. Redundant with the line below, and still the better
  // read: the operator scanning the column gets an identifier instead of a
  // sentence that says nothing.
  it('titles a nameless line with its SKU', () => {
    renderLinha([item({ sku: 'MLB-4471', mktplaceId: 'MLB999' })]);

    expect(screen.queryByText('Produto sem nome')).toBeNull();
    expect(screen.getByText('MLB-4471')).toBeTruthy();
    expect(screen.getByText(/SKU: MLB-4471/)).toBeTruthy();
    expect(screen.getByText('Não cadastrado')).toBeTruthy();
  });

  // The near-miss. A row the operator just added is also `produtoUid: null`, and
  // it must NOT be dressed up as a failed import.
  it('leaves a freshly added empty row alone', () => {
    renderLinha([item()]);

    expect(screen.getByTestId('produto-picker').textContent).toBe('Buscar produto…');
    expect(screen.queryByText('Não cadastrado')).toBeNull();
    expect(screen.queryByText('Produto sem nome')).toBeNull();
  });

  // `clearProduto` nulls nome/sku/gtin but keeps the marketplace linkage, so a
  // row whose ONLY surviving field is `mktplaceId` is a cleared row, not an
  // unresolved import.
  it('leaves a cleared marketplace row on the plain picker', () => {
    renderLinha([item({ mktplaceId: 'MLB999' })]);

    expect(screen.getByTestId('produto-picker').textContent).toBe('Buscar produto…');
    expect(screen.queryByText('Não cadastrado')).toBeNull();
  });
});

describe('item row — the produto was deleted (produtoUid set, doc absent)', () => {
  it('keeps the stored name and SKU, marks it, and drops the dead link', () => {
    produtoSnapshot = { data: null, loading: false, error: undefined, fromCache: false };
    renderLinha([item({ produtoUid: 'p1', nomeDeVenda: 'Bandeja Antiga', sku: 'BAN-1' })]);

    expect(screen.getByText('Bandeja Antiga')).toBeTruthy();
    expect(screen.getByText('Produto removido')).toBeTruthy();
    // The item's OWN sku — the row used to read `produto?.sku` alone and print
    // "Sem SKU" over a perfectly good stored one.
    expect(screen.getByText('SKU: BAN-1')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /SKU/ })).toBeNull();
  });

  // `useDocSnapshot` answers `undefined` for BOTH "still loading" and "the read
  // failed", and `null` only for a confirmed absence. Badging on anything but
  // `null` would flash a deletion over every row on every mount.
  it('claims no deletion while the doc is still in flight', () => {
    produtoSnapshot = { data: undefined, loading: true, error: undefined };
    renderLinha([item({ produtoUid: 'p1', nomeDeVenda: 'Bandeja', sku: 'BAN-1' })]);

    expect(screen.queryByText('Produto removido')).toBeNull();
    expect(screen.getByText('Bandeja')).toBeTruthy();
  });

  // The fourth state, and the one that lies. With `persistentLocalCache` an
  // offline listener raises an EMPTY snapshot for a doc that is simply not in
  // the local cache — a produto that is alive on the server. Without the
  // `fromCache` gate this paints "Produto removido" across every row of a
  // pedido opened on a flaky connection, and takes each row's link with it.
  it('claims no deletion when the empty emission came from the local cache', () => {
    produtoSnapshot = { data: null, loading: false, error: undefined, fromCache: true };
    renderLinha([item({ produtoUid: 'p1', nomeDeVenda: 'Bandeja', sku: 'BAN-1' })]);

    expect(screen.queryByText('Produto removido')).toBeNull();
    expect(screen.getByRole('link', { name: 'SKU: BAN-1' })).toBeTruthy();
  });

  it('prefers the live produto and keeps the link when the doc is there', () => {
    produtoSnapshot = {
      data: { id: 'p1', data: { nome: 'Bandeja Nova', sku: 'BAN-2' } },
      loading: false,
      error: undefined,
    };
    renderLinha([item({ produtoUid: 'p1', nomeDeVenda: 'Bandeja Antiga', sku: 'BAN-1' })]);

    expect(screen.getByText('Bandeja Nova')).toBeTruthy();
    expect(screen.queryByText('Produto removido')).toBeNull();
    expect(screen.getByRole('link', { name: 'SKU: BAN-2' })).toBeTruthy();
  });
});
