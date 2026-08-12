import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import {
  ESTADO_FRETE,
  MODALIDADE_FRETE,
  type CheckoutFretePedido,
  type Produto,
  type Usuario,
} from '@delfrance/schemas';
import { CheckoutTab } from './CheckoutTab';

// The tab reaches Firestore through useSnapshot (the checkout doc query) and
// useDocSnapshot (responsável + item produto lookups). Stub both so the test
// controls exactly what each render sees, and stub the ref plumbing
// (dereferenceOuterRef / *Collection.docRef) so it never needs a real db.
let snapshotResult: {
  data: Array<{ id: string; data: CheckoutFretePedido }> | undefined;
  loading: boolean;
  error: Error | undefined;
};
let docResults: Record<string, { data: Usuario | Produto } | undefined>;
let permissionResult: { allowed: boolean; loading: boolean } = { allowed: true, loading: false };

vi.mock('@delfrance/data', () => ({
  // The hook is mocked too, so these only need a stable identity for the
  // useMemo dep array — the real query() call would reject a fake collection
  // ref (checkoutCollection.ref is stubbed below to `{}`).
  buildQuery: () => ({ __fakeQuery: true }),
  orderByField: () => ({ __c: 'orderBy' }),
  limit: () => ({ __c: 'limit' }),
}));
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => snapshotResult,
  useDocSnapshot: (ref: { id: string } | null) =>
    ref
      ? { data: docResults[ref.id], loading: false, error: undefined }
      : { data: undefined, loading: false, error: undefined },
}));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  // Strip a `documents/<col>/<id>` outer ref down to `{ id }`, matching the
  // real helper's contract closely enough for these fixtures.
  dereferenceOuterRef: (_db: unknown, outerRef: string | null | undefined) =>
    outerRef ? { id: outerRef.split('/').pop() } : null,
}));
vi.mock('@/lib/data/usuarioCollection', () => ({
  usuarioCollection: { docRef: (_db: unknown, _p: unknown, id: string) => ({ id }) },
}));
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: { docRef: (_db: unknown, _p: unknown, id: string) => ({ id }) },
}));
vi.mock('@/lib/data/checkoutCollection', () => ({
  checkoutCollection: { ref: () => ({}) },
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/auth', () => ({
  usePermission: () => permissionResult,
}));

function renderTab(pedidoId?: string) {
  return render(
    <MantineProvider>
      <CheckoutTab pedidoId={pedidoId} />
    </MantineProvider>,
  );
}

const BASE_CHECKOUT: CheckoutFretePedido = {
  title: 'Pedido 123',
  obs: null,
  freteNoMomentoDoCheckout: {
    estado: ESTADO_FRETE.checkFinalizado,
    modalidade: MODALIDADE_FRETE.cif,
    valorCobrado: 45.9,
    codRastreio: 'BR123456789',
    volumes: [
      { quantidade: 1, pesoBruto: 2.5, dimensoes: { altura: 10, largura: 20, comprimento: 30 } },
    ],
  } as CheckoutFretePedido['freteNoMomentoDoCheckout'],
  ehDoFreteInicial: true,
  usuarioCheckoutFretePedidoOuterRef: 'documents/usuarios/u1',
  itensCheckout: [
    {
      produtoCheckoutPedidoOuterRef: 'documents/produtos/p1',
      quantidade: 2,
      dataExclusao: null,
      error: null,
      timestamp: 1_700_000_000_000,
    },
  ],
  timestamp: 1_700_000_000_000,
};

describe('CheckoutTab', () => {
  it('shows the no-pedidoId empty state without querying Firestore', () => {
    renderTab(undefined);
    expect(screen.getByText(/Checkout não disponível/)).toBeTruthy();
  });

  it('shows the no-checkout empty state when the subcollection is empty', () => {
    snapshotResult = { data: [], loading: false, error: undefined };
    renderTab('ped-1');
    expect(screen.getByText('Nenhum checkout realizado.')).toBeTruthy();
  });

  it('renders the checkout header, responsável, item and frete snapshot', () => {
    snapshotResult = {
      data: [{ id: 'chk-1', data: BASE_CHECKOUT }],
      loading: false,
      error: undefined,
    };
    docResults = {
      u1: { data: { nome: 'Operador Teste' } as Usuario },
      p1: { data: { nome: 'Produto Teste', sku: 'SKU-1' } as Produto },
    };
    renderTab('ped-1');

    expect(screen.getByText('Pedido 123')).toBeTruthy();
    expect(screen.getByText('Operador Teste')).toBeTruthy();
    expect(screen.getByText('Produto Teste')).toBeTruthy();
    expect(screen.getByText('SKU-1')).toBeTruthy();
    expect(screen.getByText('2×')).toBeTruthy();
    expect(screen.getByText(/Código de rastreio: BR123456789/)).toBeTruthy();
    expect(screen.getByText(/Valor cobrado/)).toBeTruthy();
  });

  it('shows the permission-denied message instead of resolving the responsável', () => {
    permissionResult = { allowed: false, loading: false };
    snapshotResult = {
      data: [{ id: 'chk-1', data: BASE_CHECKOUT }],
      loading: false,
      error: undefined,
    };
    docResults = {};
    renderTab('ped-1');

    expect(screen.getByText(/Sem permissão para ver o usuário responsável/)).toBeTruthy();
    permissionResult = { allowed: true, loading: false };
  });

  it('marks a soft-deleted item and an errored item distinctly', () => {
    snapshotResult = {
      data: [
        {
          id: 'chk-1',
          data: {
            ...BASE_CHECKOUT,
            itensCheckout: [
              {
                produtoCheckoutPedidoOuterRef: 'documents/produtos/p1',
                quantidade: 1,
                dataExclusao: 1_700_000_100_000,
                error: null,
                timestamp: 1_700_000_000_000,
              },
              {
                produtoCheckoutPedidoOuterRef: 'documents/produtos/p2',
                quantidade: 1,
                dataExclusao: null,
                error: 'Quantidade excedida',
                timestamp: 1_700_000_000_000,
              },
            ],
          },
        },
      ],
      loading: false,
      error: undefined,
    };
    docResults = {
      p1: { data: { nome: 'Excluído', sku: null } as Produto },
      p2: { data: { nome: 'Com erro', sku: null } as Produto },
    };
    renderTab('ped-1');

    expect(screen.getByText(/Excluído em/)).toBeTruthy();
    expect(screen.getByText('Quantidade excedida')).toBeTruthy();
  });
});
