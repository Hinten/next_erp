import { useEffect, useState } from 'react';
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
}));

vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

// The lista guard in `handlePick` needs a resolvable lista ref; nothing else
// here resolves, so no re-price runs and no produto doc is read.
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: (_db: unknown, ref: unknown) =>
    typeof ref === 'string' && ref.startsWith('documents/listas/')
      ? { id: 'L1', path: 'listas/L1' }
      : null,
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

vi.mock('@delfrance/data/hooks', async () => {
  const { useEffect: useEff, useState: useSt } = await import('react');
  return {
    useDocSnapshot: (ref: { __lista?: string } | null) => {
      const [data, setData] = useSt<{ id: string; data: object } | undefined>(undefined);
      const id = ref?.__lista ?? null;
      useEff(() => {
        setData(id ? { id, data: {} } : undefined);
      }, [id]);
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
      integracaoPedidoOuterRef: null,
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
