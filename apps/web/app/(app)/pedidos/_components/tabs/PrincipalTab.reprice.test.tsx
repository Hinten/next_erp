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
 * The lista-de-preços re-price.
 *
 * It must run when the OPERATOR picks a different tabela and at no other time,
 * which is why it hangs off the picker's `onChange` rather than watching the
 * form value. A watcher cannot tell an operator's pick from the value merely
 * ARRIVING, and three different arrivals look identical to it — the snapshot
 * resolving on mount, a remount under `keepMounted={false}`, and
 * `useServerTruthSeed`'s `form.reset`. Each one rewrote historical prices and
 * dirtied the form; on an already-paid, locked pedido that silently replaced
 * prices that are a matter of record. One case below covers each.
 *
 * Sibling file `PrincipalTab.test.tsx` keeps re-pricing switched off (its
 * `dereferenceOuterRef` stub returns null) so it can test the #470 remount
 * contract in isolation; the mocks here are the live ones.
 */

const h = vi.hoisted(() => ({
  notify: vi.fn(),
  getDoc: vi.fn(),
  LISTA_A: 'documents/listas/L1',
  LISTA_B: 'documents/listas/L2',
  /** The live `onChange` the tab handed the picker, for the programmatic case. */
  pickerOnChange: { current: null as null | ((next: string | null) => void) },
}));

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
// ⚠️ This stub reproduces the real hook's TIMING, and that is load-bearing:
// `useDocSnapshot` starts at `data: undefined` and resolves only after an
// effect runs (packages/data/src/hooks/useSnapshot.ts). A stub that answered
// synchronously would make the "does not re-price on open" case vacuous — the
// arrival that caused the bug would simply never happen.
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
vi.mock('@/components/pickers/ProdutoPicker', () => ({ ProdutoPicker: () => null }));

// Stands in for the Mantine Select: a button that reports a pick, and honours
// `disabled` exactly as the real picker does (`disabled={disabled || …}`).
vi.mock('@/components/pickers/ListaDePrecosPicker', () => ({
  ListaDePrecosPicker: ({
    onChange,
    disabled,
  }: {
    onChange: (next: string | null) => void;
    disabled?: boolean;
  }) => {
    h.pickerOnChange.current = onChange;
    return (
      <button
        type="button"
        data-testid="lista-picker"
        disabled={disabled}
        onClick={() => onChange(h.LISTA_B)}
      >
        Escolher lista B
      </button>
    );
  },
}));

/**
 * The produto's price differs per lista, and BOTH differ from the price stored
 * on the pedido item — so a re-price is always visible, and "did not re-price"
 * can never be confused with "re-priced to the same number".
 */
const PRODUTO = {
  nome: 'Produto Seed',
  precos: { L1: { valor: 10 }, L2: { valor: 42.5 } },
} as unknown as Produto;

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
      listaDePrecosOuterRef: h.LISTA_A,
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

const listaPicker = () => screen.getByTestId('lista-picker') as HTMLButtonElement;
const preco = () => formRef.getValues('_itensFlat.0.precoDeVenda');
const repriced = () =>
  h.notify.mock.calls.some(([arg]) =>
    /Preços atualizados/.test(String((arg as { message?: unknown } | undefined)?.message)),
  );

/** Let any in-flight lookup (getDoc → setValue) settle before asserting. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.notify.mockClear();
  h.pickerOnChange.current = null;
  h.getDoc.mockReset();
  h.getDoc.mockImplementation((ref: { __produto?: string }) =>
    Promise.resolve({ data: () => (ref?.__produto === 'prod-1' ? PRODUTO : undefined) }),
  );
});

describe('PrincipalTab — lista de preços re-price', () => {
  // The positive control. Without it every negative case below would also pass
  // against a re-price that simply never runs.
  it('re-prices when the operator picks a different lista', async () => {
    render(<Host />);
    await settle();

    act(() => {
      fireEvent.click(listaPicker());
    });

    await waitFor(() => expect(preco()).toBe(42.5));
    expect(repriced()).toBe(true);
    expect(formRef.getValues('listaDePrecosOuterRef')).toBe(h.LISTA_B);
  });

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

  it('does not re-price when the form re-seeds to server truth with a different lista', async () => {
    render(<Host />);
    await settle();

    // What `useServerTruthSeed` does when the cache-painted copy (lista A) is
    // corrected to server truth (lista B) — another operator changed it, and
    // the server already holds the right item prices. Not the operator here.
    act(() => {
      formRef.reset({ ...formRef.getValues(), listaDePrecosOuterRef: h.LISTA_B });
    });
    await settle();

    expect(repriced()).toBe(false);
    expect(preco()).toBe(PRECO_SALVO);
    expect(h.getDoc).not.toHaveBeenCalled();
  });

  it('never re-prices a locked pedido', async () => {
    render(<Host disabled />);
    await settle();

    // The real protection: the operator cannot reach `onChange` at all.
    expect(listaPicker().disabled).toBe(true);

    // Defence in depth: a programmatic caller must not re-price either.
    act(() => {
      h.pickerOnChange.current?.(h.LISTA_B);
    });
    await settle();

    expect(repriced()).toBe(false);
    expect(preco()).toBe(PRECO_SALVO);
    expect(h.getDoc).not.toHaveBeenCalled();
  });
});
