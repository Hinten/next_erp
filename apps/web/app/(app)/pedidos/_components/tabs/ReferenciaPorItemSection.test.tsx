import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import type { Pedido } from '@delfrance/schemas';
import { ReferenciaPorItemSection } from './ReferenciaPorItemSection';
import type { FlatItem, PedidoFormState } from '../types';

// The operação read is not the subject here (no operação → finNFe 1, saída).
vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: () => ({ data: undefined, loading: false, error: undefined }),
}));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({ dereferenceOuterRef: () => null }));

const CHAVE = '35260514200166000187550010000000071000000011';

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
      <ReferenciaPorItemSection form={form} db={{} as Firestore} destinatarioDocumento={null} />
    </MantineTestProvider>
  );
}

const chaveDoItem = (n: number) =>
  screen.getByLabelText(`Chave referenciada do item ${n}`) as HTMLInputElement;
const nItemDoItem = (n: number) =>
  screen.getByLabelText(`Item da nota original para o item ${n}`) as HTMLInputElement;

describe('ReferenciaPorItemSection (#330)', () => {
  it('writes chave and nItem onto the item in the form', () => {
    render(<Host itens={[linha('a', 'Camiseta'), linha('b', 'Calça')]} />);

    fireEvent.change(chaveDoItem(1), { target: { value: CHAVE } });
    fireEvent.change(nItemDoItem(1), { target: { value: '3' } });

    expect(formRef.getValues('_itensFlat.0.dfeReferenciado')).toEqual({
      chaveAcesso: CHAVE,
      nItem: 3,
    });
    expect(formRef.getValues('_itensFlat.1.dfeReferenciado')).toBeNull();
  });

  it('flags a chave with a wrong check digit on its own field', () => {
    render(<Host itens={[linha('a', 'Camiseta')]} />);
    fireEvent.change(chaveDoItem(1), { target: { value: `${CHAVE.slice(0, 43)}2` } });
    expect(screen.getByText('Chave inválida (formato ou dígito verificador)')).toBeTruthy();
  });

  it('warns — without blocking — what SEFAZ would refuse, e.g. a missing nItem (1048)', () => {
    render(
      <Host
        itens={[linha('a', 'Camiseta', { dfeReferenciado: { chaveAcesso: CHAVE, nItem: null } })]}
      />,
    );
    expect(screen.getByText('A SEFAZ recusaria esta nota assim')).toBeTruthy();
    expect(
      screen.getByText(
        'Item 1: Informe o número do item da nota referenciada (nItem). (SEFAZ 1048)',
      ),
    ).toBeTruthy();
  });

  it('applies the first chave to every item that has none, keeping their nItem', () => {
    render(
      <Host
        itens={[
          linha('a', 'Camiseta', { dfeReferenciado: { chaveAcesso: CHAVE, nItem: 1 } }),
          linha('b', 'Calça', { dfeReferenciado: { chaveAcesso: '', nItem: 2 } }),
          linha('c', 'Meia'),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar a mesma chave a todos' }));
    expect(formRef.getValues('_itensFlat.1.dfeReferenciado')).toEqual({
      chaveAcesso: CHAVE,
      nItem: 2,
    });
    expect(formRef.getValues('_itensFlat.2.dfeReferenciado')).toEqual({
      chaveAcesso: CHAVE,
      nItem: null,
    });
  });

  it('removing a reference stores null — never an empty object', () => {
    render(
      <Host
        itens={[linha('a', 'Camiseta', { dfeReferenciado: { chaveAcesso: CHAVE, nItem: 1 } })]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remover referência do item 1' }));
    expect(formRef.getValues('_itensFlat.0.dfeReferenciado')).toBeNull();
  });

  it('clearing the chave of a reference with no nItem stores null', () => {
    render(
      <Host
        itens={[linha('a', 'Camiseta', { dfeReferenciado: { chaveAcesso: 'X', nItem: null } })]}
      />,
    );
    fireEvent.change(chaveDoItem(1), { target: { value: '' } });
    expect(formRef.getValues('_itensFlat.0.dfeReferenciado')).toBeNull();
  });

  it('skips a row marked for deletion', () => {
    render(<Host itens={[linha('a', 'Camiseta', { _delete: true }), linha('b', 'Calça')]} />);
    expect(screen.queryByText(/Camiseta/)).toBeNull();
    expect(screen.getByText(/1\. Calça/)).toBeTruthy();
  });
});
