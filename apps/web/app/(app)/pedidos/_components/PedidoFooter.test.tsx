import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import { formatReais } from '@delfrance/core/money';
import {
  ESTADO_PEDIDO,
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  type ItemDoPedido,
  type Pedido,
} from '@delfrance/schemas';
import { PedidoFooter } from './PedidoFooter';
import type { FlatItem, PedidoFormState } from './types';

// The footer reads pagamentos via useSnapshot. Mock the hook (data per test, none
// by default) plus the query builders / collection handle so building the query
// with a fake db never touches Firestore — even in the edit-mode case where
// pedidoId is set.
const snapshot = vi.hoisted(() => ({
  data: undefined as Array<{ id: string; data: Record<string, unknown> }> | undefined,
}));
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => ({ data: snapshot.data, loading: false, error: undefined }),
}));
vi.mock('@delfrance/data', () => ({
  buildQuery: () => ({}),
  orderByField: () => ({}),
}));
vi.mock('@/lib/data/pagamentoCollection', () => ({
  pagamentoCollection: { ref: () => ({}) },
}));

function item(overrides: Partial<FlatItem> = {}): FlatItem {
  return {
    _rowId: 'row-1',
    _delete: false,
    produtoUid: 'prod-1',
    ordem: 1,
    mktplaceId: null,
    sku: null,
    gtin: null,
    nomeDeVenda: 'Item',
    precoDeVenda: 33.5,
    descontoUnitario: 0,
    quantidade: 1,
    custo: null,
    timestamp: null,
    imposto: null,
    ...overrides,
  } as FlatItem;
}

/** A returned item worth `(preco − desconto) × quantidade` — the troca's credit. */
function devolvido(preco: number, quantidade = 1, desconto = 0): ItemDoPedido {
  return {
    produtoUid: 'prod-1',
    ordem: 1,
    precoDeVenda: preco,
    descontoUnitario: desconto,
    quantidade,
  } as unknown as ItemDoPedido;
}

/** `itensDevolvidos` map holding the given items under one origem / produto. */
function devolucao(...itens: ItemDoPedido[]): NonNullable<PedidoFormState['itensDevolvidos']> {
  return { origem1: { produto1: itens } };
}

/** A pagamento row as `useSnapshot` hands it to the footer. */
function pagamentoDoc(
  valor: number,
  { forma = FORMA_PAGAMENTO.pix }: { forma?: number } = {},
): { id: string; data: Record<string, unknown> } {
  return {
    id: `pg-${valor}-${forma}`,
    data: { valor, status_pagamento: STATUS_PAGAMENTO.aprovado, forma_de_pagamento: forma },
  };
}

/** The value `<Text>` under a footer stat's label. */
function statValue(label: string): string {
  return screen.getByText(label).nextElementSibling?.textContent ?? '';
}

let formRef: UseFormReturn<PedidoFormState, unknown, Pedido>;

beforeEach(() => {
  snapshot.data = undefined;
});

function Host({
  pedidoId,
  onSaveAndContinue,
  ehSaida,
  itens,
  itensDevolvidos = null,
  estado,
}: {
  pedidoId?: string;
  onSaveAndContinue?: () => void;
  ehSaida?: boolean;
  /** Initial item rows (defaults to none). */
  itens?: FlatItem[];
  /** Initial `itensDevolvidos` (defaults to none). */
  itensDevolvidos?: PedidoFormState['itensDevolvidos'];
  /** Initial estado (defaults to the form's own default: unset). */
  estado?: PedidoFormState['estado'];
} = {}) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: {
      _itensFlat: itens ?? [],
      descontoTotal: 0,
      freteInicial: null,
      itensDevolvidos,
      ...(estado ? { estado } : {}),
    },
  });
  // Expose the (stable) form to the test in an effect, not during render.
  useEffect(() => {
    formRef = form;
  }, [form]);
  return (
    <MantineTestProvider>
      <PedidoFooter
        form={form}
        db={{} as Firestore}
        pedidoId={pedidoId}
        canWrite
        disabled={false}
        submitLabel="Salvar"
        isSubmitting={false}
        submitError={null}
        ehSaida={ehSaida}
        onSaveAndContinue={onSaveAndContinue}
      />
    </MantineTestProvider>
  );
}

describe('PedidoFooter — live total reactivity', () => {
  it('re-derives the total when items change after the initial render', () => {
    render(<Host />);
    // Starts empty → R$ 0,00.
    expect(screen.getByTestId('footer-total').textContent).toContain('0,00');

    // Add a priced item the way the Principal tab does (setValue, no parent
    // re-render). With `form.watch` the footer would stay frozen at 0,00; with
    // `useWatch` it subscribes and re-renders.
    act(() => {
      formRef.setValue('_itensFlat', [item()]);
    });
    expect(screen.getByTestId('footer-total').textContent).toContain('33,50');

    // Edit the row (qty 2, desconto 1,50) → (33,50 − 1,50) × 2 = R$ 64,00.
    act(() => {
      formRef.setValue('_itensFlat', [item({ quantidade: 2, descontoUnitario: 1.5 })]);
    });
    expect(screen.getByTestId('footer-total').textContent).toContain('64,00');
  });

  it('drops staged-deleted and in-progress rows from the total', () => {
    render(<Host />);
    act(() => {
      formRef.setValue('_itensFlat', [
        item({ _rowId: 'a', precoDeVenda: 10, quantidade: 1 }),
        item({ _rowId: 'b', _delete: true, precoDeVenda: 999, quantidade: 1 }),
        item({
          _rowId: 'c',
          produtoUid: null,
          mktplaceId: null,
          precoDeVenda: 0.01,
          quantidade: 1,
        }),
      ]);
    });
    // Only the first row counts → R$ 10,00.
    expect(screen.getByTestId('footer-total').textContent).toContain('10,00');
  });
});

describe('PedidoFooter — fields and actions', () => {
  it('always shows the Devoluções field, even at zero', () => {
    render(<Host />);
    expect(screen.getByText('Devoluções')).toBeTruthy();
    // It renders its R$ 0,00 value alongside the label.
    expect(screen.getAllByText(/R\$\s*0,00/).length).toBeGreaterThan(0);
  });

  it('shows Vlr. Pago only in edit mode, but there even at zero', () => {
    // Create mode (no pedidoId) → no payments concept → hidden.
    const { unmount } = render(<Host />);
    expect(screen.queryByText('Vlr. Pago')).toBeNull();
    unmount();

    // Edit mode → visible even at R$ 0,00.
    render(<Host pedidoId="ped-1" />);
    expect(screen.getByText('Vlr. Pago')).toBeTruthy();
  });

  it('renders the share-orçamento button on a saída (default)', () => {
    render(<Host />);
    expect(screen.getByLabelText('Compartilhar orçamento')).toBeTruthy();
  });

  it('hides the share-orçamento button on an entrada', () => {
    // An orçamento (quote) is a sale-side artifact — it has no meaning for an
    // inbound entrada (purchase / return), so the menu must not render.
    render(<Host ehSaida={false} />);
    expect(screen.queryByLabelText('Compartilhar orçamento')).toBeNull();
  });

  it('shows "Salvar e continuar editando" only in edit mode (pedidoId + handler)', () => {
    const { unmount } = render(<Host />);
    expect(screen.queryByRole('button', { name: 'Salvar e continuar editando' })).toBeNull();
    unmount();

    render(<Host pedidoId="ped-1" onSaveAndContinue={() => {}} />);
    expect(screen.getByRole('button', { name: 'Salvar e continuar editando' })).toBeTruthy();
  });
});

describe('PedidoFooter — troca devolução credit', () => {
  // The sale is R$ 150,00 gross; the customer takes back R$ 100,00 of goods.
  const venda = [item({ precoDeVenda: 150 })];

  it('shows the NET total, the gross devoluções and the gross subtotal', () => {
    render(<Host itens={venda} itensDevolvidos={devolucao(devolvido(100))} />);
    expect(screen.getByTestId('footer-total').textContent).toBe(formatReais(50));
    expect(statValue('Devoluções')).toBe(formatReais(100));
    expect(statValue('Subtotal')).toBe(formatReais(150));
  });

  it('nets (preço − desconto) × quantidade, not the sticker price', () => {
    // (60 − 10) × 2 = 100 → same R$ 50,00 total. Sticker 60 × 2 = 120 would read 30.
    render(<Host itens={venda} itensDevolvidos={devolucao(devolvido(60, 2, 10))} />);
    expect(screen.getByTestId('footer-total').textContent).toBe(formatReais(50));
  });

  it('an entrada takes no credit (near-miss: same data, opposite direction)', () => {
    render(<Host itens={venda} itensDevolvidos={devolucao(devolvido(100))} ehSaida={false} />);
    expect(screen.getByTestId('footer-total').textContent).toBe(formatReais(150));
  });

  it('turns negative when the return is worth more than the sale', () => {
    const vendaMenor = [item({ precoDeVenda: 100 })];
    render(<Host itens={vendaMenor} itensDevolvidos={devolucao(devolvido(130))} />);
    expect(screen.getByTestId('footer-total').textContent).toBe(formatReais(-30));
  });

  it('re-derives the net total when the devolução changes after the initial render', () => {
    render(<Host itens={venda} />);
    expect(screen.getByTestId('footer-total').textContent).toBe(formatReais(150));
    act(() => {
      formRef.setValue('itensDevolvidos', devolucao(devolvido(100)));
    });
    expect(screen.getByTestId('footer-total').textContent).toBe(formatReais(50));
  });

  it('CREATE mode: a credit above the gross total shows Troco (legacy parity)', () => {
    // No pedido yet ⇒ no pagamentos: the credit is the only thing counted.
    const vendaMenor = [item({ precoDeVenda: 100 })];
    render(<Host itens={vendaMenor} itensDevolvidos={devolucao(devolvido(130))} />);
    expect(statValue('Troco')).toBe(formatReais(30));
    // …and Vlr. Pago stays a payments figure, hidden with no pedido.
    expect(screen.queryByText('Vlr. Pago')).toBeNull();
  });

  it('CREATE mode: a credit that only equals the total shows no Troco (near-miss)', () => {
    const vendaMenor = [item({ precoDeVenda: 100 })];
    render(<Host itens={vendaMenor} itensDevolvidos={devolucao(devolvido(100))} />);
    expect(screen.queryByText('Troco')).toBeNull();
    expect(screen.getByTestId('footer-total').textContent).toBe(formatReais(0));
  });
});

describe('PedidoFooter — Vlr. Pago / Troco over a troca', () => {
  const venda = [item({ precoDeVenda: 150 })];
  const troca = devolucao(devolvido(100));

  it('Vlr. Pago counts the payments only, never the credit', () => {
    snapshot.data = [pagamentoDoc(50)];
    render(<Host pedidoId="ped-1" itens={venda} itensDevolvidos={troca} />);
    expect(statValue('Vlr. Pago')).toBe(formatReais(50));
  });

  it('a payment that exactly covers the difference leaves no Troco', () => {
    snapshot.data = [pagamentoDoc(50)];
    render(<Host pedidoId="ped-1" itens={venda} itensDevolvidos={troca} />);
    expect(screen.queryByText('Troco')).toBeNull();
  });

  it('a payment above the difference shows the excess as Troco', () => {
    snapshot.data = [pagamentoDoc(60)];
    render(<Host pedidoId="ped-1" itens={venda} itensDevolvidos={troca} />);
    expect(statValue('Troco')).toBe(formatReais(10));
  });

  it('one cent above the difference is one cent of Troco (near-miss)', () => {
    snapshot.data = [pagamentoDoc(50.01)];
    render(<Host pedidoId="ped-1" itens={venda} itensDevolvidos={troca} />);
    expect(statValue('Troco')).toBe(formatReais(0.01));
  });

  it('a crédito loja payment replaces the credit instead of doubling it', () => {
    // The returned R$ 100 is registered as a crédito loja payment (to emit the
    // NF-e) and R$ 50 is paid on top: credit 100 − 100 = 0, paid 150 = the total.
    snapshot.data = [pagamentoDoc(100, { forma: FORMA_PAGAMENTO.credito_loja }), pagamentoDoc(50)];
    render(<Host pedidoId="ped-1" itens={venda} itensDevolvidos={troca} />);
    expect(statValue('Vlr. Pago')).toBe(formatReais(150));
    // Counted twice it would read 100 + 150 − 150 = R$ 100,00 of Troco.
    expect(screen.queryByText('Troco')).toBeNull();
    expect(screen.getByTestId('footer-total').textContent).toBe(formatReais(150));
  });
});

describe('PedidoFooter — underpaid warning over a troca', () => {
  const TOOLTIP = 'Valor pago menor que o total do pedido';
  const venda = [item({ precoDeVenda: 150 })];
  const troca = devolucao(devolvido(100));

  /** Hovers the element Mantine's Tooltip wraps around a flagged "Vlr. Pago". */
  function hoverVlrPago(): void {
    const stat = screen.getByText('Vlr. Pago').parentElement;
    expect(stat?.parentElement).not.toBeNull();
    fireEvent.mouseEnter(stat!.parentElement!);
  }

  it('flags a pago pedido whose payments + credit fall one cent short', async () => {
    snapshot.data = [pagamentoDoc(49.99)];
    render(
      <Host pedidoId="ped-1" itens={venda} itensDevolvidos={troca} estado={ESTADO_PEDIDO.pago} />,
    );
    hoverVlrPago();
    expect(await screen.findByText(TOOLTIP)).not.toBeNull();
  });

  it('does not flag a pago pedido whose payments + credit cover the total', async () => {
    snapshot.data = [pagamentoDoc(50)];
    render(
      <Host pedidoId="ped-1" itens={venda} itensDevolvidos={troca} estado={ESTADO_PEDIDO.pago} />,
    );
    hoverVlrPago();
    await Promise.resolve();
    expect(screen.queryByText(TOOLTIP)).toBeNull();
  });

  it('an entrada gets no credit, so the same numbers are flagged', async () => {
    snapshot.data = [pagamentoDoc(50)];
    render(
      <Host
        pedidoId="ped-1"
        itens={venda}
        itensDevolvidos={troca}
        estado={ESTADO_PEDIDO.pago}
        ehSaida={false}
      />,
    );
    hoverVlrPago();
    expect(await screen.findByText(TOOLTIP)).not.toBeNull();
  });

  it('never flags a pedido that is not pago', async () => {
    snapshot.data = [pagamentoDoc(49.99)];
    render(
      <Host
        pedidoId="ped-1"
        itens={venda}
        itensDevolvidos={troca}
        estado={ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento}
      />,
    );
    hoverVlrPago();
    await Promise.resolve();
    expect(screen.queryByText(TOOLTIP)).toBeNull();
  });
});
