import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import type { Pedido, Produto } from '@delfrance/schemas';
import { PrincipalTab } from './PrincipalTab';
import type { FlatItem, PedidoFormState } from '../types';

/**
 * Which produto a pedido LINE binds to (#1398).
 *
 * This is the highest-consequence binding in the stack: `sincronizarEstoquePedido`
 * reserves and removes stock against `item.produtoUid` and has NO read-through
 * of its own, so a line naming a family-of-one parent — a wrapper that owns no
 * estoque rows — makes `aplicarPlano` create one at `0 + delta`, i.e. drive it
 * negative from nothing.
 *
 * ⚠️ Asserted on the form value, not on anything rendered: the id written is the
 * whole point, and it is what a later save persists.
 */
const h = vi.hoisted(() => ({
  notify: vi.fn(),
  /** The live `onChange` the tab handed the picker. */
  onChange: { current: null as null | ((r: { id: string; data: Produto } | null) => void) },
  /** Seeded estoque rows by doc id — drives the absence guard. */
  linhas: { current: {} as Record<string, { quantidade: number; quantidadeReservada: number }> },
}));

vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

// `getDoc` answers the absence guard from `linhas`; the produto doc reads that
// `handlePick`'s reprice makes resolve to nothing, exactly as before.
vi.mock('firebase/firestore', async (importActual) => {
  const actual = await importActual<typeof import('firebase/firestore')>();
  return {
    ...actual,
    getDoc: async (ref: { __estoque?: string }) => {
      const linha = ref.__estoque ? h.linhas.current[ref.__estoque] : undefined;
      return { exists: () => linha !== undefined, data: () => linha };
    },
  };
});

// The lista guard in `handlePick` needs a resolvable lista ref; nothing else
// here resolves, so no re-price runs and no produto doc is read.
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: (_db: unknown, ref: unknown) => {
    if (typeof ref !== 'string') return null;
    if (ref.startsWith('documents/listas/')) return { id: 'L1', path: 'listas/L1' };
    // The integração and the depósito it points at — without a depósito the
    // absence guard is skipped entirely, which would make its tests vacuous.
    if (ref.startsWith('documents/integracao/')) return { id: 'I1', path: 'integracao/I1' };
    if (ref.startsWith('documents/depositos/')) return { id: 'dep1', path: 'depositos/dep1' };
    return null;
  },
}));
vi.mock('@/lib/data/listaDePrecosCollection', () => ({
  listaDePrecosCollection: { docRef: () => ({ __lista: 'L1' }) },
}));
vi.mock('@/lib/data/integracaoCollection', () => ({
  integracaoCollection: { docRef: () => ({ __integracao: true }) },
}));
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: { docRef: (_db: unknown, _ctx: unknown, id: string) => ({ __produto: id }) },
}));
vi.mock('@/lib/data/estoqueProdutoCollection', () => ({
  estoqueProdutoCollection: {
    docRef: (_db: unknown, c: { produtoId: string }, id: string) => ({ __estoque: id, ...c }),
  },
}));

vi.mock('@delfrance/data/hooks', async () => {
  const { useEffect: useEff, useState: useSt } = await import('react');
  return {
    useDocSnapshot: (ref: { __lista?: string; __integracao?: boolean } | null) => {
      const [data, setData] = useSt<{ id: string; data: object } | undefined>(undefined);
      const id = ref?.__lista ?? (ref?.__integracao ? 'I1' : null);
      const ehIntegracao = ref?.__integracao === true;
      useEff(() => {
        setData(
          id
            ? {
                id,
                data: ehIntegracao ? { depositoOuterRef: 'documents/depositos/dep1' } : {},
              }
            : undefined,
        );
      }, [id, ehIntegracao]);
      return { data, loading: false, error: undefined };
    },
  };
});

vi.mock('../useEstoqueDisponivel', () => ({ useEstoqueDisponivel: () => null }));
vi.mock('@/components/ProdutoThumbnail', () => ({ ProdutoThumbnail: () => null }));
vi.mock('../ProdutoVariacaoLabel', () => ({ ProdutoVariacaoLabel: () => null }));
vi.mock('@/components/pickers/ClientePicker', () => ({ ClientePicker: () => null }));
vi.mock('@/components/pickers/OperacaoPicker', () => ({ OperacaoPicker: () => null }));
vi.mock('@/components/pickers/IntegracaoPicker', () => ({ IntegracaoPicker: () => null }));
vi.mock('@/components/pickers/ListaDePrecosPicker', () => ({ ListaDePrecosPicker: () => null }));

// Stands in for the real picker: captures `onChange` so a test can drive a pick.
// The real one hands back `{ id, data }` and the tab calls `handlePick(r.data, r.id)`.
vi.mock('@/components/pickers/ProdutoPicker', () => ({
  ProdutoPicker: ({
    onChange,
  }: {
    onChange: (r: { id: string; data: Produto } | null) => void;
  }) => {
    h.onChange.current = onChange;
    return null;
  },
}));

const db = {} as Firestore;
let formRef: UseFormReturn<PedidoFormState, unknown, Pedido>;

/** An EMPTY row — that is what mounts the ProdutoPicker. */
function emptyItem(): FlatItem {
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
    precoDeVenda: 0.01,
    descontoUnitario: 0,
    quantidade: 1,
    custo: null,
    timestamp: null,
    imposto: null,
  } as FlatItem;
}

function Host() {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: {
      ehSaida: true,
      _itensFlat: [emptyItem()],
      observacoesInternas: null,
      clientePedidoOuterRef: null,
      operacaoPedidoOuterRef: null,
      integracaoPedidoOuterRef: 'documents/integracao/I1',
      listaDePrecosOuterRef: 'documents/listas/L1',
    },
  });
  useEffect(() => {
    formRef = form;
  }, [form]);
  return (
    <MantineTestProvider>
      <PrincipalTab form={form} db={db} disabled={false} />
    </MantineTestProvider>
  );
}

const produto = (over: Partial<Produto> = {}) =>
  ({
    nome: 'Bandeja',
    sku: 'BAN-1',
    gtin: '789',
    paiId: null,
    filhoUnicoId: null,
    ...over,
  }) as Produto;

const pick = async (p: Produto, id: string) => {
  await waitFor(() => expect(h.onChange.current).not.toBeNull());
  await act(async () => {
    h.onChange.current!({ id, data: p });
  });
};

const linha = () => formRef.getValues('_itensFlat.0');

beforeEach(() => {
  h.notify.mockClear();
  h.onChange.current = null;
  h.linhas.current = {};
});

describe('PrincipalTab — a pedido line binds the sellable unit', () => {
  it('writes the CHILD id when the operator picks a family-of-one parent', async () => {
    render(<Host />);
    await pick(produto({ filhoUnicoId: 'c1' }), 'p1');
    await waitFor(() => expect(linha().produtoUid).toBe('c1'));
  });

  // ⚠️ The denormalised fields stay the MATCHED produto's. The sole member copies
  // `nome`/`sku` but NOT `gtin`, and NF-e needs at least one of sku/gtin.
  it('carries the picked produto’s sku, gtin and nome onto the line', async () => {
    render(<Host />);
    await pick(produto({ filhoUnicoId: 'c1' }), 'p1');
    await waitFor(() => expect(linha().produtoUid).toBe('c1'));
    expect(linha()).toMatchObject({ sku: 'BAN-1', gtin: '789', nomeDeVenda: 'Bandeja' });
  });

  it('writes the picked id unchanged for an ordinary produto', async () => {
    render(<Host />);
    await pick(produto(), 'p1');
    await waitFor(() => expect(linha().produtoUid).toBe('p1'));
  });

  it('writes the child’s own id when a variation child is picked', async () => {
    render(<Host />);
    await pick(produto({ paiId: 'p1' }), 'c1');
    await waitFor(() => expect(linha().produtoUid).toBe('c1'));
  });

  // The drift guard, on the binding path: a child carrying a stale pointer binds
  // itself, never the produto the stale pointer names.
  it('does not follow a stale filhoUnicoId on a child', async () => {
    render(<Host />);
    await pick(produto({ paiId: 'p1', filhoUnicoId: 'algum-outro' }), 'c1');
    await waitFor(() => expect(linha().produtoUid).toBe('c1'));
  });
});

/**
 * ⚠️ A KIT is never resolved. It holds no stock of its own —
 * `calcularAlteracoesEstoque` expands it into COMPONENTS — so the only thing the
 * line needs from the produto it names is the composition, and a sole member
 * does not always have it: `planejarMembroUnico` copies `ehKit` and NOT
 * `componentesKit`. Binding such a child gives the sync `ehKit: true` with no
 * map, and its `if (!componentes) continue;` decrements NOTHING.
 */
describe('PrincipalTab — a kit line stays on the parent', () => {
  it('does not resolve a kit to its sole member', async () => {
    render(<Host />);
    await pick(produto({ ehKit: true, filhoUnicoId: 'c1' }), 'kit-1');
    await waitFor(() => expect(linha().produtoUid).toBe('kit-1'));
  });

  it('still resolves a NON-kit with the same shape', async () => {
    render(<Host />);
    await pick(produto({ ehKit: false, filhoUnicoId: 'c1' }), 'p1');
    await waitFor(() => expect(linha().produtoUid).toBe('c1'));
  });
});

/**
 * ⚠️ The write side asks the same "does the target actually have a row?"
 * question the read side does — it just cannot answer it the same way.
 * `sincronizarEstoquePedido` has no read-through: it reserves against
 * `est-<produtoUid>-<dep>` and `aplicarPlano` CREATES that row at `0 - qty`.
 */
describe('PrincipalTab — the binding follows the stock when they disagree', () => {
  it('keeps the line on the PARENT when only the parent holds units', async () => {
    h.linhas.current = { 'est-p1-dep1': { quantidade: 10, quantidadeReservada: 0 } };
    render(<Host />);
    await pick(produto({ filhoUnicoId: 'c1' }), 'p1');
    await waitFor(() => expect(linha().produtoUid).toBe('p1'));
  });

  it('binds the CHILD when the child holds the units', async () => {
    h.linhas.current = { 'est-c1-dep1': { quantidade: 10, quantidadeReservada: 0 } };
    render(<Host />);
    await pick(produto({ filhoUnicoId: 'c1' }), 'p1');
    await waitFor(() => expect(linha().produtoUid).toBe('c1'));
  });

  // ⚠️ "The child has no row" is not sufficient on its own: a produto born as a
  // family of one has no rows ANYWHERE until someone books stock, and that stock
  // goes to the child.
  it('binds the CHILD when neither holds units', async () => {
    render(<Host />);
    await pick(produto({ filhoUnicoId: 'c1' }), 'p1');
    await waitFor(() => expect(linha().produtoUid).toBe('c1'));
  });

  it('binds the CHILD when both hold units — the parent residual is not a redirect', async () => {
    h.linhas.current = {
      'est-p1-dep1': { quantidade: 10, quantidadeReservada: 0 },
      'est-c1-dep1': { quantidade: 3, quantidadeReservada: 0 },
    };
    render(<Host />);
    await pick(produto({ filhoUnicoId: 'c1' }), 'p1');
    await waitFor(() => expect(linha().produtoUid).toBe('c1'));
  });

  // A parent whose units are ALL reserved holds nothing available, so it cannot
  // claim the line back.
  it('binds the CHILD when the parent’s units are entirely reserved', async () => {
    h.linhas.current = { 'est-p1-dep1': { quantidade: 10, quantidadeReservada: 10 } };
    render(<Host />);
    await pick(produto({ filhoUnicoId: 'c1' }), 'p1');
    await waitFor(() => expect(linha().produtoUid).toBe('c1'));
  });
});
