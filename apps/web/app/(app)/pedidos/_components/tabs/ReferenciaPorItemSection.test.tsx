import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import type { Pedido } from '@delfrance/schemas';
import { ReferenciaPorItemSection } from './ReferenciaPorItemSection';
import type { FlatItem, PedidoFormState } from '../types';

// The operação read: none by default (→ finNFe 1, saída); a test that needs a
// devolução sets `mocks.operacao`. The origin NF-es the fill button reads come
// from `mocks.nfesPorPedido` through the client port.
const mocks = vi.hoisted(() => ({
  operacao: undefined as { id: string; data: Record<string, unknown> } | undefined,
  nfesPorPedido: {} as Record<string, Array<Record<string, unknown>>>,
}));
vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: () => ({ data: mocks.operacao, loading: false, error: undefined }),
}));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({ dereferenceOuterRef: () => null }));
vi.mock('@/lib/pedidos/clientPort', () => ({
  createClientPedidoPort: () => ({
    listNFesAprovadas: async (pedidoId: string) => mocks.nfesPorPedido[pedidoId] ?? [],
  }),
}));

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
    ajusteRtc: null,
    ...over,
  };
}

let formRef: UseFormReturn<PedidoFormState, unknown, Pedido>;

function Host({
  itens,
  saidasRelacionadas = null,
}: {
  itens: FlatItem[];
  saidasRelacionadas?: string[] | null;
}) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: {
      _itensFlat: itens,
      chNFeReferenciadas: null,
      operacaoPedidoOuterRef: null,
      saidasRelacionadas,
    },
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

  it('skips the blank "Adicionar produto" row, so it shifts no later number', () => {
    // No produto and no marketplace id: the save drops it, so the emission
    // never numbers it. Near-miss: a row with only a marketplace id is kept.
    render(
      <Host
        itens={[
          linha('a', 'Em branco', { produtoUid: null, ordem: 1 }),
          linha('b', 'Calça', { ordem: 2 }),
          linha('c', 'Anúncio', { produtoUid: null, mktplaceId: 'MLB1', ordem: 3 }),
        ]}
      />,
    );
    expect(screen.queryByText(/Em branco/)).toBeNull();
    expect(screen.getByText(/1\. Calça/)).toBeTruthy();
    expect(screen.getByText(/2\. Anúncio/)).toBeTruthy();
  });

  it('numbers the lines in the pedido line order (ordem), as the emission numbers det/nItem', () => {
    // The form array holds A₁, A₂, B₁ but the lines were entered A₁, B₁, A₂
    // (ordem 1, 3, 2): "Item 2" must be B₁, the second det the nota carries.
    render(
      <Host
        itens={[
          linha('a1', 'Camiseta P', { produtoUid: 'p-A', ordem: 1 }),
          linha('a2', 'Camiseta G', {
            produtoUid: 'p-A',
            ordem: 3,
            dfeReferenciado: { chaveAcesso: CHAVE, nItem: null },
          }),
          linha('b1', 'Calça', { produtoUid: 'p-B', ordem: 2 }),
        ]}
      />,
    );
    expect(screen.getByText(/1\. Camiseta P/)).toBeTruthy();
    expect(screen.getByText(/2\. Calça/)).toBeTruthy();
    expect(screen.getByText(/3\. Camiseta G/)).toBeTruthy();
    // The rule warning names the same number as the row label…
    expect(
      screen.getByText(
        'Item 3: Informe o número do item da nota referenciada (nItem). (SEFAZ 1048)',
      ),
    ).toBeTruthy();
    // …and editing "item 2" writes onto B₁ (form index 2), not onto A₂.
    fireEvent.change(chaveDoItem(2), { target: { value: CHAVE } });
    expect(formRef.getValues('_itensFlat.2.dfeReferenciado')).toEqual({
      chaveAcesso: CHAVE,
      nItem: null,
    });
    expect(formRef.getValues('_itensFlat.1.dfeReferenciado')).toEqual({
      chaveAcesso: CHAVE,
      nItem: null,
    });
  });
});

/** A minimal authorized `<nfeProc>` carrying `cProds` as its dets, in order. */
function procCom(cProds: readonly string[]): string {
  const dets = cProds
    .map(
      (cProd, i) =>
        `<det nItem="${i + 1}"><prod><cProd>${cProd}</cProd><xProd>P</xProd>` +
        `<uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>10.00</vUnCom></prod></det>`,
    )
    .join('');
  return `<nfeProc><NFe><infNFe Id="NFe" versao="4.00">${dets}</infNFe></NFe></nfeProc>`;
}

describe('ReferenciaPorItemSection — devolução (VC02-14, #1683)', () => {
  const DEVOLUCAO = { id: 'opDev', data: { finNFe: 4, tipo: 0 } };

  afterEach(() => {
    mocks.operacao = undefined;
    mocks.nfesPorPedido = {};
  });

  it('says the reference is mandatory on every devolução, with or without the RTC', () => {
    render(<Host itens={[linha('a', 'Camiseta')]} />);
    expect(
      screen.getByText(/Obrigatório em toda devolução, com ou sem a Reforma Tributária/),
    ).toBeTruthy();
  });

  it('warns that SEFAZ refuses a devolução whose items reference nothing (321)', () => {
    mocks.operacao = DEVOLUCAO;
    render(<Host itens={[linha('a', 'Camiseta')]} />);
    expect(
      screen.getByText(
        /Na devolução, cada item deve referenciar o item da nota de origem.*\(SEFAZ 321\)/,
      ),
    ).toBeTruthy();
  });

  it('NEAR-MISS: the fill button exists only on a devolução', () => {
    render(<Host itens={[linha('a', 'Camiseta')]} saidasRelacionadas={['o1']} />);
    expect(
      screen.queryByRole('button', { name: 'Preencher a partir das NF-e de origem' }),
    ).toBeNull();
  });

  it('fills each pending item from its origin NF-e line, keeping a complete reference', async () => {
    mocks.operacao = DEVOLUCAO;
    mocks.nfesPorPedido = {
      o1: [{ chave: CHAVE, ultima_modificacao: 1, xml_nfe_proc: procCom(['SKU-B', 'SKU-A']) }],
    };
    render(
      <Host
        saidasRelacionadas={['o1']}
        itens={[
          linha('a', 'Camiseta', { sku: 'SKU-A', ordem: 1 }),
          linha('b', 'Calça', { sku: 'SKU-B', ordem: 2 }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preencher a partir das NF-e de origem' }));
    await waitFor(() =>
      expect(formRef.getValues('_itensFlat.0.dfeReferenciado')).toEqual({
        chaveAcesso: CHAVE,
        nItem: 2,
      }),
    );
    expect(formRef.getValues('_itensFlat.1.dfeReferenciado')).toEqual({
      chaveAcesso: CHAVE,
      nItem: 1,
    });
  });

  it('is disabled for a devolução tied to no origin pedido (typed by hand)', () => {
    mocks.operacao = DEVOLUCAO;
    render(<Host itens={[linha('a', 'Camiseta')]} />);
    const botao = screen.getByRole('button', { name: 'Preencher a partir das NF-e de origem' });
    expect((botao as HTMLButtonElement).disabled).toBe(true);
  });
});
