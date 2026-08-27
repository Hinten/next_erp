import { useEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Tabs } from '@mantine/core';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import type { Pedido, Produto } from '@delfrance/schemas';
import { PrincipalTab } from './PrincipalTab';
import type { FlatItem, PedidoFormState } from '../types';

/**
 * The lista-de-preços re-price effect.
 *
 * It must fire when the OPERATOR picks a different tabela and at no other time.
 * It used to key off the lista's *snapshot* id, which starts undefined and
 * lands a beat later — so `null` → `'L1'` on mount looked exactly like a new
 * tabela being chosen, and merely OPENING a pedido rewrote every row's price
 * (and dirtied the form). On an already-paid, locked pedido that silently
 * replaced historical prices with today's.
 *
 * Sibling file `PrincipalTab.test.tsx` keeps this effect switched off (its
 * `dereferenceOuterRef` stub returns null) so it can test the #470 remount
 * contract in isolation; the mocks here are the live ones.
 */

const h = vi.hoisted(() => ({ notify: vi.fn(), getDoc: vi.fn() }));

vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

vi.mock('firebase/firestore', async (importActual) => {
  const actual = await importActual<typeof import('firebase/firestore')>();
  return { ...actual, getDoc: h.getDoc };
});

// `documents/listas/<id>` → a ref-shaped stub; anything else (the integração
// ref the tab also dereferences) stays null.
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: (_db: unknown, ref: unknown) => {
    if (typeof ref !== 'string' || !ref.startsWith('documents/listas/')) return null;
    const id = ref.split('/').pop() as string;
    return { id, path: `listas/${id}` };
  },
}));
vi.mock('@/lib/data/listaDePrecosCollection', () => ({
  listaDePrecosCollection: {
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ __lista: id }),
  },
}));
vi.mock('@/lib/data/integracaoCollection', () => ({
  integracaoCollection: { docRef: () => ({ __integracao: true }) },
}));
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: { docRef: (_db: unknown, _ctx: unknown, id: string) => ({ __produto: id }) },
}));

// Only the lista doc resolves — it is the existence check behind `handlePick`'s
// "Selecione uma tabela de preços" guard. Everything else stays unresolved.
//
// ⚠️ This stub reproduces the real hook's TIMING, and that is the entire point
// of this file: `useDocSnapshot` starts at `data: undefined` and resolves only
// after an effect runs (packages/data/src/hooks/useSnapshot.ts). A stub that
// answered synchronously would make every assertion below vacuous — the
// null → id transition that caused the bug would simply never happen.
vi.mock('@delfrance/data/hooks', async () => {
  const { useEffect, useState } = await import('react');
  return {
    useDocSnapshot: (ref: { __lista?: string } | null) => {
      const [data, setData] = useState<{ id: string; data: object } | undefined>(undefined);
      const id = ref?.__lista ?? null;
      useEffect(() => {
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
vi.mock('@/components/pickers/ProdutoPicker', () => ({ ProdutoPicker: () => null }));

/**
 * The produto's price differs per lista, and BOTH differ from the price stored
 * on the pedido item — so a re-price is always visible, and "did not re-price"
 * can never be confused with "re-priced to the same number".
 */
const PRODUTO = {
  nome: 'Produto Seed',
  precos: { L1: { valor: 10 }, L2: { valor: 42.5 } },
} as unknown as Produto;

const LISTA_A = 'documents/listas/L1';
const LISTA_B = 'documents/listas/L2';
const PRECO_SALVO = 7.77;

function seededItem(): FlatItem {
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
    precoDeVenda: PRECO_SALVO,
    descontoUnitario: 0,
    quantidade: 1,
    custo: null,
    timestamp: null,
    imposto: null,
  } as FlatItem;
}

/** Stable across renders, exactly like PedidoForm's memoized `getFirebaseFirestore()`. */
const db = {} as Firestore;

let formRef: UseFormReturn<PedidoFormState, unknown, Pedido>;

function Host({ disabled = false }: { disabled?: boolean } = {}) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: {
      ehSaida: true,
      _itensFlat: [seededItem()],
      observacoesInternas: null,
      clientePedidoOuterRef: null,
      operacaoPedidoOuterRef: null,
      integracaoPedidoOuterRef: null,
      // A saved pedido always arrives with its lista already set.
      listaDePrecosOuterRef: LISTA_A,
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
          <PrincipalTab form={form} db={db} disabled={disabled} />
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

const preco = () => formRef.getValues('_itensFlat.0.precoDeVenda');
const repriced = () =>
  h.notify.mock.calls.some(([arg]) =>
    /Preços atualizados/.test(String((arg as { message?: unknown } | undefined)?.message)),
  );

/** Let any in-flight effect (getDoc → setValue) settle before asserting. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.notify.mockClear();
  h.getDoc.mockReset();
  h.getDoc.mockImplementation((ref: { __produto?: string }) =>
    Promise.resolve({ data: () => (ref?.__produto === 'prod-1' ? PRODUTO : undefined) }),
  );
});

describe('PrincipalTab — lista de preços re-price', () => {
  it('does not re-price on open, on a pedido that already has a lista', async () => {
    render(<Host />);
    await settle();

    expect(repriced()).toBe(false);
    expect(preco()).toBe(PRECO_SALVO);
    expect(h.getDoc).not.toHaveBeenCalled();
  });

  it('does not re-price when the tab remounts (keepMounted={false})', async () => {
    render(<Host />);
    await settle();

    switchTo('outra');
    switchTo('principal');
    await settle();

    expect(repriced()).toBe(false);
    expect(preco()).toBe(PRECO_SALVO);
  });

  it('re-prices when the operator picks a different lista', async () => {
    render(<Host />);
    await settle();

    act(() => {
      formRef.setValue('listaDePrecosOuterRef', LISTA_B, { shouldDirty: true });
    });
    await waitFor(() => expect(preco()).toBe(42.5));
    expect(repriced()).toBe(true);
  });

  it('never re-prices a locked pedido, even when the lista changes', async () => {
    render(<Host disabled />);
    await settle();

    act(() => {
      formRef.setValue('listaDePrecosOuterRef', LISTA_B, { shouldDirty: true });
    });
    await settle();

    expect(repriced()).toBe(false);
    expect(preco()).toBe(PRECO_SALVO);
    expect(h.getDoc).not.toHaveBeenCalled();
  });
});
