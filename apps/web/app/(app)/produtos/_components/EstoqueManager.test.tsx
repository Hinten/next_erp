import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { Firestore, FirestoreError } from 'firebase/firestore';
import { makeEstoqueUid, type EstoqueProduto } from '@delfrance/schemas';

// Hoisted mocks (vi.mock factories can't close over normal consts).
const h = vi.hoisted(() => ({
  state: {
    current: {
      depositos: [] as { id: string; nome: string }[],
      parent: null as { nome: string; sku: string } | null,
      children: [] as { id: string; nome: string; sku: string; ordem: number }[],
      /** produtoId → estoque docs, or `undefined` for "still loading". */
      estoques: {} as Record<string, { id: string; data: Partial<EstoqueProduto> }[] | undefined>,
      estoquesError: undefined as FirestoreError | undefined,
    },
  },
}));

vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown, constraints: unknown[]) => ({ base, constraints }),
  orderByField: vi.fn(),
  limit: vi.fn(),
  whereEqual: vi.fn(),
}));

// Queries are dispatched by the marker their (mocked) collection ref carries.
interface Marker {
  kind: 'depositos' | 'produtos' | 'estoques';
  produtoId?: string;
}
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: (q: { base: Marker } | null) => {
    if (!q) return { data: undefined, loading: false, error: undefined };
    const s = h.state.current;
    if (q.base.kind === 'depositos') {
      return {
        data: s.depositos.map((d) => ({ id: d.id, data: { nome: d.nome, ativo: true } })),
        loading: false,
        error: undefined,
      };
    }
    if (q.base.kind === 'produtos') {
      return {
        data: s.children.map((c) => ({
          id: c.id,
          data: { nome: c.nome, sku: c.sku, ordem: c.ordem, ehKit: false, componentesKit: null },
        })),
        loading: false,
        error: undefined,
      };
    }
    if (s.estoquesError) return { data: undefined, loading: false, error: s.estoquesError };
    const rows = s.estoques[q.base.produtoId ?? ''];
    return { data: rows, loading: rows === undefined, error: undefined };
  },
  useDocSnapshot: () => {
    const p = h.state.current.parent;
    return {
      data: p
        ? { id: 'pai', data: { nome: p.nome, sku: p.sku, ehKit: false, componentesKit: null } }
        : undefined,
      loading: p === null,
      error: undefined,
    };
  },
}));

vi.mock('@/lib/data/depositoCollection', () => ({
  depositoCollection: { ref: () => ({ kind: 'depositos' }) },
}));
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: {
    ref: () => ({ kind: 'produtos' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ kind: 'produtoDoc', id }),
  },
}));
vi.mock('@/lib/data/estoqueProdutoCollection', () => ({
  estoqueProdutoCollection: {
    ref: (_db: unknown, ctx: { produtoId: string }) => ({
      kind: 'estoques',
      produtoId: ctx.produtoId,
    }),
  },
}));
vi.mock('@/lib/produtos/clientPort', () => ({ setEstoqueLocalizacao: vi.fn() }));
// The quantity editor is its own screen (callable + history table); this suite
// is about which sections render, not what the modal does.
vi.mock('./EstoqueMovimentacaoModal', () => ({ EstoqueMovimentacaoModal: () => null }));

import { EstoqueManager, residualEstoquePai } from './EstoqueManager';

const db = {} as unknown as Firestore;
const DEP = 'Depósito 1';

function est(
  produtoId: string,
  quantidade: number,
  quantidadeReservada = 0,
): { id: string; data: Partial<EstoqueProduto> } {
  return {
    id: makeEstoqueUid(produtoId, 'd1'),
    data: { quantidade, quantidadeReservada, localizacao: null },
  };
}

interface SetupOptions {
  children?: { id: string; nome: string; sku: string; ordem: number }[];
  estoques?: Record<string, { id: string; data: Partial<EstoqueProduto> }[] | undefined>;
  estoquesError?: FirestoreError;
}

function setup(opts: SetupOptions = {}) {
  h.state.current = {
    depositos: [{ id: 'd1', nome: DEP }],
    parent: { nome: 'Camiseta Preta', sku: 'CAM' },
    children: opts.children ?? [],
    estoques: opts.estoques ?? { pai: [] },
    estoquesError: opts.estoquesError,
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<EstoqueManager produtoId="pai" db={db} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MantineTestProvider>
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </MantineTestProvider>
    ),
  });
}

/** The parent's depósito row is identified by its aria-labelled cells. */
const linhaDoPai = () => screen.queryByLabelText(`Disponível pai ${DEP}`);
const linhaDaVariacao = (id: string) => screen.queryByLabelText(`Disponível ${id} ${DEP}`);
const alerta = () => screen.queryByText(/o estoque deve ficar nas variações/i);
const toggle = () => screen.queryByRole('button', { name: /estoque do produto pai/i });

const FILHOS = [
  { id: 'f1', nome: 'Camiseta Preta P', sku: 'CAM-P', ordem: 0 },
  { id: 'f2', nome: 'Camiseta Preta M', sku: 'CAM-M', ordem: 1 },
];

afterEach(() => vi.clearAllMocks());

describe('EstoqueManager', () => {
  // CONTROL: without this, a component that hides the parent unconditionally
  // would pass every other test in this file.
  it('shows the parent section normally when the produto has no variations', () => {
    setup({ estoques: { pai: [est('pai', 7)] } });

    expect(linhaDoPai()).toBeTruthy();
    expect(screen.getByText('CAM - Camiseta Preta')).toBeTruthy();
    expect(alerta()).toBeNull();
    expect(toggle()).toBeNull();
  });

  it('hides an empty parent behind a toggle when the produto has variations', () => {
    setup({ children: FILHOS, estoques: { pai: [], f1: [est('f1', 10)], f2: [est('f2', 4)] } });

    expect(linhaDoPai()).toBeNull();
    expect(linhaDaVariacao('f1')).toBeTruthy();
    expect(linhaDaVariacao('f2')).toBeTruthy();
    expect(alerta()).toBeNull();

    // The exact locator `produto-estoque.emulator.e2e.spec.ts` drives.
    expect(screen.queryByLabelText(`Localização pai ${DEP}`)).toBeNull();

    const botao = toggle();
    expect(botao).toBeTruthy();
    fireEvent.click(botao!);

    expect(linhaDoPai()).toBeTruthy();
    expect(screen.getByLabelText(`Localização pai ${DEP}`)).toBeTruthy();
    expect(screen.getByText('CAM - Camiseta Preta (produto pai)')).toBeTruthy();
  });

  it('warns and keeps the parent EDITABLE when it still holds stock', () => {
    setup({ children: FILHOS, estoques: { pai: [est('pai', 3, 1)], f1: [], f2: [] } });

    expect(alerta()).toBeTruthy();
    expect(screen.getByText(/3,00 em estoque e 1,00 reservada\(s\) no produto pai/)).toBeTruthy();
    expect(linhaDoPai()).toBeTruthy();
    expect(toggle()).toBeNull();

    // ⚠️ Disabling the parent would strand the residual — it is exactly the
    // units an operator has to move onto a variação from here.
    const editar = screen.getByLabelText(`Editar estoque pai ${DEP}`);
    expect(editar.hasAttribute('disabled')).toBe(false);
  });

  // The ML UP sole-member migration moves only the AVAILABLE units and leaves
  // the reserved ones on the parent on purpose — `disponivel` is 0 here, so a
  // `estoqueDisponivel`-based check would hide them.
  it('treats a reserved-only balance as a residual', () => {
    setup({ children: FILHOS, estoques: { pai: [est('pai', 0, 2)], f1: [], f2: [] } });

    expect(alerta()).toBeTruthy();
    expect(screen.getByText(/2,00 reservada\(s\) no produto pai/)).toBeTruthy();
    expect(screen.queryByText(/em estoque/)).toBeNull();
    expect(linhaDoPai()).toBeTruthy();
  });

  // `quantidade === quantidadeReservada` ⇒ `estoqueDisponivel` is 0. Any check
  // written against *disponível* — the number the row actually displays — hides
  // 3 real units here. This is the case that distinguishes the two rules.
  it('treats a fully-reserved balance as a residual', () => {
    setup({ children: FILHOS, estoques: { pai: [est('pai', 3, 3)], f1: [], f2: [] } });

    expect(alerta()).toBeTruthy();
    expect(screen.getByText(/3,00 em estoque e 3,00 reservada\(s\) no produto pai/)).toBeTruthy();
    expect(linhaDoPai()).toBeTruthy();
    expect(toggle()).toBeNull();
  });

  it('shows neither the alert nor the toggle while the parent estoques load', () => {
    setup({ children: FILHOS, estoques: { pai: undefined, f1: [], f2: [] } });

    expect(linhaDoPai()).toBeNull();
    expect(alerta()).toBeNull();
    expect(toggle()).toBeNull();
    expect(linhaDaVariacao('f1')).toBeTruthy();
  });

  it('falls back to showing the parent when its estoques fail to load', () => {
    setup({
      children: FILHOS,
      estoquesError: { code: 'permission-denied', message: 'nope' } as FirestoreError,
    });

    expect(linhaDoPai()).toBeTruthy();
    expect(alerta()).toBeNull();
    expect(toggle()).toBeNull();
  });
});

describe('residualEstoquePai', () => {
  it('sums both halves and reports nothing for an all-zero parent', () => {
    expect(residualEstoquePai([])).toEqual({ temResidual: false, quantidade: 0, reservada: 0 });
    expect(
      residualEstoquePai([
        { quantidade: 0, quantidadeReservada: 0 },
        { quantidade: 0, quantidadeReservada: 0 },
      ]),
    ).toEqual({ temResidual: false, quantidade: 0, reservada: 0 });
    expect(
      residualEstoquePai([
        { quantidade: 2, quantidadeReservada: 0 },
        { quantidade: 3, quantidadeReservada: 1 },
      ]),
    ).toEqual({ temResidual: true, quantidade: 5, reservada: 1 });
  });

  // Same distinction as the component test above, at the unit level.
  it('is not `disponivel` — a fully-reserved balance still counts', () => {
    expect(residualEstoquePai([{ quantidade: 3, quantidadeReservada: 3 }])).toEqual({
      temResidual: true,
      quantidade: 3,
      reservada: 3,
    });
  });

  it('counts a negative or non-finite balance as a residual', () => {
    expect(residualEstoquePai([{ quantidade: -2, quantidadeReservada: 0 }]).temResidual).toBe(true);
    expect(residualEstoquePai([{ quantidade: NaN, quantidadeReservada: 0 }]).temResidual).toBe(
      true,
    );
    // A junk value must not poison the total it is excluded from.
    expect(
      residualEstoquePai([
        { quantidade: NaN, quantidadeReservada: 0 },
        { quantidade: 4, quantidadeReservada: 0 },
      ]).quantidade,
    ).toBe(4);
  });
});
