import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import type { Pedido } from '@delfrance/schemas';
import { AjusteRtcSection } from './AjusteRtcSection';
import type { FlatItem, PedidoFormState } from '../types';

/** The operação the section reads — each test sets its tipo. */
let operacao: Record<string, unknown> | undefined;
vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: () => ({
    data: operacao ? { id: 'op', data: operacao } : undefined,
    loading: false,
    error: undefined,
  }),
}));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({ dereferenceOuterRef: () => null }));

const debito = (tpNFDebito: string) => ({ tipo: 1, finNFe: 6, tpNFDebito, tpNFCredito: null });

function linha(rowId: string, nomeDeVenda: string, over: Partial<FlatItem> = {}): FlatItem {
  return {
    _rowId: rowId,
    produtoUid: `p-${rowId}`,
    ordem: 1,
    ensureUniqueId: null,
    mktplaceId: null,
    sku: null,
    gtin: null,
    nomeDeVenda,
    precoDeVenda: 10,
    descontoUnitario: 0,
    quantidade: 1,
    custo: null,
    timestamp: null,
    imposto: null,
    dfeReferenciado: null,
    ajusteRtc: null,
    ...over,
  };
}

let formRef: UseFormReturn<PedidoFormState, unknown, Pedido>;

function Host({ itens }: { itens: FlatItem[] }) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: { _itensFlat: itens, chNFeReferenciadas: null, operacaoPedidoOuterRef: null },
  });
  useEffect(() => {
    formRef = form;
  }, [form]);
  return (
    <MantineTestProvider>
      <AjusteRtcSection form={form} db={{} as Firestore} />
    </MantineTestProvider>
  );
}

describe('AjusteRtcSection (#330)', () => {
  it('renders nothing for a tipo without an adjustment group and no stored amounts', () => {
    operacao = debito('06');
    render(<Host itens={[linha('a', 'Multa')]} />);
    expect(screen.queryByLabelText('IBS do ajuste do item 1')).toBeNull();
    expect(screen.queryByText(/ajuste|Limpar valores/i)).toBeNull();
  });

  it('débito 01: names the group, writes the amounts, asks for the missing ones', () => {
    operacao = debito('01');
    render(<Host itens={[linha('a', 'Crédito A'), linha('b', 'Crédito B')]} />);

    expect(screen.getByText('Transferência de crédito (gTransfCred)')).toBeTruthy();
    // No competência outside gAjusteCompet.
    expect(screen.queryByLabelText('Competência do ajuste do item 1')).toBeNull();
    // Both items still lack amounts: the emission would refuse them.
    expect(
      screen.getByText(
        'Item 2: Informe os valores de IBS e CBS do ajuste deste item (aba Fiscal).',
      ),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('IBS do ajuste do item 1'), {
      target: { value: '12,34' },
    });
    expect(formRef.getValues('_itensFlat.0.ajusteRtc')).toEqual({
      vIBS: 12.34,
      vCBS: 0,
      competApur: null,
    });
    expect(formRef.getValues('_itensFlat.1.ajusteRtc')).toBeNull();
  });

  it('débito 02: offers the competência and stores it on the item', () => {
    operacao = debito('02');
    render(
      <Host
        itens={[linha('a', 'Anulação', { ajusteRtc: { vIBS: 1, vCBS: 9, competApur: null } })]}
      />,
    );

    expect(screen.getByText('Ajuste de competência (gAjusteCompet)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Competência do ajuste do item 1'), {
      target: { value: '2026-08' },
    });
    expect(formRef.getValues('_itensFlat.0.ajusteRtc')).toEqual({
      vIBS: 1,
      vCBS: 9,
      competApur: '2026-08',
    });
  });

  it('removing an adjustment stores null — never an empty object', () => {
    operacao = debito('07');
    render(
      <Host itens={[linha('a', 'Perda', { ajusteRtc: { vIBS: 1, vCBS: 9, competApur: null } })]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remover ajuste do item 1' }));
    expect(formRef.getValues('_itensFlat.0.ajusteRtc')).toBeNull();
  });

  it('keeps stale amounts visible under a tipo that ignores them, with a way to clear them', () => {
    operacao = { tipo: 1, finNFe: 1, tpNFDebito: null, tpNFCredito: null };
    render(
      <Host itens={[linha('a', 'Venda', { ajusteRtc: { vIBS: 1, vCBS: 9, competApur: null } })]} />,
    );

    expect(
      screen.getByText(
        'Item 1: Este item tem valores de ajuste de IBS/CBS, mas o tipo desta nota não os usa — serão ignorados.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar valores' }));
    expect(formRef.getValues('_itensFlat.0.ajusteRtc')).toBeNull();
  });

  it('crédito 05 is not emitted, so no editor is offered for it', () => {
    operacao = { tipo: 0, finNFe: 5, tpNFDebito: null, tpNFCredito: '05' };
    render(<Host itens={[linha('a', 'Sucessão')]} />);
    expect(screen.queryByLabelText('IBS do ajuste do item 1')).toBeNull();
    expect(screen.queryByText(/ajuste|Limpar valores/i)).toBeNull();
  });
});
