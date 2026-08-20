import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  ESTADO_FRETE,
  MODALIDADE_FRETE,
  type CheckoutFretePedido,
  type Produto,
  type Usuario,
} from '@delfrance/schemas';
import { CheckoutTab } from './CheckoutTab';

// The tab reaches Firestore through useSnapshot (the checkout doc query),
// useDocSnapshot (the responsável lookup) and a TanStack useQuery (the
// batched produto lookup — see the getDocsByIds review finding). Stub all
// three so the test controls exactly what each render sees, and stub the ref
// plumbing (dereferenceOuterRef / *Collection.docRef) so it never needs a
// real db. `vi.hoisted` + `beforeEach` resets: a thrown assertion in one test
// must never leave stale state for the next (previously fixed in review —
// `permissionResult` used to be restored on the test body's last line).
const { snapState, docState, permState, produtoQueryState } = vi.hoisted(() => ({
  snapState: {
    current: {
      data: undefined as Array<{ id: string; data: CheckoutFretePedido }> | undefined,
      loading: false,
      error: undefined as Error | undefined,
    },
  },
  docState: {
    current: {} as Record<string, { data: Usuario } | undefined>,
  },
  permState: {
    current: { allowed: true, loading: false },
  },
  produtoQueryState: {
    current: {
      data: undefined as Map<string, Produto> | undefined,
      isLoading: false,
    },
  },
}));

vi.mock('@delfrance/data', () => ({
  // The hook is mocked too, so these only need a stable identity for the
  // useMemo dep array — the real query() call would reject a fake collection
  // ref (checkoutCollection.ref is stubbed below to `{}`).
  buildQuery: () => ({ __fakeQuery: true }),
  orderByField: () => ({ __c: 'orderBy' }),
  limit: () => ({ __c: 'limit' }),
}));
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => snapState.current,
  useDocSnapshot: (ref: { id: string } | null) =>
    ref
      ? { data: docState.current[ref.id], loading: false, error: undefined }
      : { data: undefined, loading: false, error: undefined },
}));
vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return { ...actual, useQuery: () => produtoQueryState.current };
});
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
  produtoCollection: {},
}));
vi.mock('@/lib/data/getDocsByIds', () => ({
  // The mocked useQuery above never calls this — stubbed only so the
  // component's static import resolves.
  getDocsByIds: vi.fn(),
}));
vi.mock('@/lib/data/checkoutCollection', () => ({
  checkoutCollection: { ref: () => ({}) },
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/auth', () => ({
  usePermission: () => permState.current,
}));

function renderTab(pedidoId?: string) {
  return render(
    <MantineTestProvider>
      <CheckoutTab pedidoId={pedidoId} />
    </MantineTestProvider>,
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
  beforeEach(() => {
    snapState.current = { data: undefined, loading: false, error: undefined };
    docState.current = {};
    permState.current = { allowed: true, loading: false };
    produtoQueryState.current = { data: undefined, isLoading: false };
  });

  it('shows the no-pedidoId empty state without querying Firestore', () => {
    renderTab(undefined);
    expect(screen.getByText(/Checkout não disponível/)).toBeTruthy();
  });

  it('shows the no-checkout empty state when the subcollection is empty', () => {
    snapState.current = { data: [], loading: false, error: undefined };
    renderTab('ped-1');
    expect(screen.getByText('Nenhum checkout realizado.')).toBeTruthy();
  });

  it('renders the checkout header, responsável, item and frete snapshot', () => {
    snapState.current = {
      data: [{ id: 'chk-1', data: BASE_CHECKOUT }],
      loading: false,
      error: undefined,
    };
    docState.current = { u1: { data: { nome: 'Operador Teste' } as Usuario } };
    produtoQueryState.current = {
      data: new Map([['p1', { nome: 'Produto Teste', sku: 'SKU-1' } as Produto]]),
      isLoading: false,
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
    permState.current = { allowed: false, loading: false };
    snapState.current = {
      data: [{ id: 'chk-1', data: BASE_CHECKOUT }],
      loading: false,
      error: undefined,
    };
    renderTab('ped-1');

    expect(screen.getByText(/Sem permissão para ver o usuário responsável/)).toBeTruthy();
  });

  it('marks a soft-deleted item and an errored item distinctly', () => {
    snapState.current = {
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
    produtoQueryState.current = {
      data: new Map([
        ['p1', { nome: 'Excluído', sku: null } as Produto],
        ['p2', { nome: 'Com erro', sku: null } as Produto],
      ]),
      isLoading: false,
    };
    renderTab('ped-1');

    expect(screen.getByText(/Excluído em/)).toBeTruthy();
    expect(screen.getByText('Quantidade excedida')).toBeTruthy();
  });

  it('shows a "sem frete" fallback instead of crashing when freteNoMomentoDoCheckout is missing', () => {
    // parseSoftRead returns the raw doc (not a validated one) on a schema
    // mismatch, so the field the type claims is always present can be
    // undefined at runtime — the review finding this guards against.
    const { freteNoMomentoDoCheckout: _omit, ...checkoutWithoutFrete } = BASE_CHECKOUT;
    snapState.current = {
      data: [{ id: 'chk-1', data: checkoutWithoutFrete as CheckoutFretePedido }],
      loading: false,
      error: undefined,
    };
    renderTab('ped-1');

    expect(screen.getByText('Sem frete registrado.')).toBeTruthy();
  });
});
