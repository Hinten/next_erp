import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CAMPO_RASCUNHO_SHOPEE, type CamposRascunhoShopee } from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  FRASE_CONFLITO_CRIACAO_RASCUNHO_SHOPEE,
  FRASE_CONFLITO_RASCUNHO_SHOPEE,
  FRASE_RASCUNHO_CARREGANDO_SHOPEE,
  TITULO_CONFLITO_RASCUNHO_SHOPEE,
} from '@/lib/shopee/anuncioProduto';
import { formularioDoRascunhoShopee, type EdicaoRascunhoShopee } from '@/lib/shopee/rascunho';

import {
  ConflitoRascunhoShopeeModal,
  FRASE_CONFLITO_RENOVADO_RASCUNHO_SHOPEE,
  textoDoValorDoRascunhoShopee,
  type ConflitoRascunhoShopeeAberto,
} from './ConflitoRascunhoShopeeModal';

/** The 409 field diff — presentational: what it shows, and which callback each button fires. */

const LINK = 'rasc00000000000000001';

const BASE: CamposRascunhoShopee = {
  item_name: 'Camiseta',
  description: null,
  category_id: 100087,
  marca: { brand_id: 77, original_brand_name: 'Nike' },
  attributes: null,
};

const EDICAO: EdicaoRascunhoShopee = {
  linkDocId: LINK,
  contaId: 'int-1',
  novo: false,
  base: BASE,
  atual: {
    ...formularioDoRascunhoShopee(BASE),
    item_name: 'Camiseta azul',
    marca: { brand_id: 0, original_brand_name: null },
  },
  digitacoesAtributos: {},
  salvo: null,
};

const EDITADO: ConflitoRascunhoShopeeAberto = {
  linkDocId: LINK,
  operacao: 'atualizar',
  conflitos: [
    { campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta verde' },
    { campo: CAMPO_RASCUNHO_SHOPEE.marca, atual: { brand_id: 99, original_brand_name: 'Adidas' } },
  ],
};

function show(
  props: {
    conflito?: ConflitoRascunhoShopeeAberto | null;
    edicao?: EdicaoRascunhoShopee | null;
    servidorCarregado?: boolean;
    salvando?: boolean;
  } = {},
) {
  const cb = {
    onSalvarMesmoAssim: vi.fn(),
    onUsarOQueEstaSalvo: vi.fn(),
    onCancelar: vi.fn(),
    onSubmit: vi.fn((e: { preventDefault: () => void }) => e.preventDefault()),
  };
  render(
    <MantineTestProvider>
      {/* The editor sits inside the produto's <form>: no button here may submit it. */}
      <form onSubmit={cb.onSubmit}>
        <ConflitoRascunhoShopeeModal
          conflito={props.conflito === undefined ? EDITADO : props.conflito}
          edicao={props.edicao === undefined ? EDICAO : props.edicao}
          servidorCarregado={props.servidorCarregado ?? true}
          salvando={props.salvando ?? false}
          onSalvarMesmoAssim={cb.onSalvarMesmoAssim}
          onUsarOQueEstaSalvo={cb.onUsarOQueEstaSalvo}
          onCancelar={cb.onCancelar}
        />
      </form>
    </MantineTestProvider>,
  );
  return cb;
}

const botao = (nome: string) =>
  within(screen.getByTestId('shopee-rascunho-conflito')).getByRole('button', { name: nome });

function celulas(campo: string): string[] {
  return within(screen.getByTestId(`shopee-rascunho-conflito-${campo}`))
    .getAllByRole('cell')
    .map((c) => c.textContent ?? '');
}

function cabecalhos(): string[] {
  return screen.getAllByRole('columnheader').map((c) => c.textContent ?? '');
}

describe('ConflitoRascunhoShopeeModal — open / closed', () => {
  it('closed (`conflito: null`) renders nothing', () => {
    show({ conflito: null, edicao: null });
    expect(screen.queryByTestId('shopee-rascunho-conflito')).toBeNull();
  });

  it('NEAR-MISS: open renders the root, the title and the EDIT alert', () => {
    show();
    expect(screen.getByTestId('shopee-rascunho-conflito')).toBeTruthy();
    expect(screen.getByText(TITULO_CONFLITO_RASCUNHO_SHOPEE)).toBeTruthy();
    expect(screen.getByText(FRASE_CONFLITO_RASCUNHO_SHOPEE)).toBeTruthy();
    expect(screen.queryByText(FRASE_CONFLITO_CRIACAO_RASCUNHO_SHOPEE)).toBeNull();
  });
});

describe('ConflitoRascunhoShopeeModal — the rows', () => {
  it('an EDIT: one row per conflicting field — when you opened / saved now / your change', () => {
    show();
    expect(cabecalhos()).toEqual(['Campo', 'Quando você abriu', 'Salvo agora', 'Sua alteração']);
    expect(celulas('item_name')).toEqual(['Título', 'Camiseta', 'Camiseta verde', 'Camiseta azul']);
    expect(celulas('marca')).toEqual(['Marca', 'Nike', 'Adidas', 'Sem marca (No Brand)']);
    // Only the fields the 409 named.
    expect(screen.queryByTestId('shopee-rascunho-conflito-description')).toBeNull();
  });

  it('NEAR-MISS: a CREATE retry opened nothing stored — no «Quando você abriu» column, its own alert', () => {
    show({
      conflito: {
        linkDocId: LINK,
        operacao: 'criar',
        conflitos: [
          { campo: CAMPO_RASCUNHO_SHOPEE.categoryId, atual: 100090 },
          {
            campo: CAMPO_RASCUNHO_SHOPEE.attributes,
            atual: [{ attribute_id: 1 }, { attribute_id: 2 }],
          },
        ],
      },
      edicao: { ...EDICAO, novo: true },
    });
    expect(screen.getByText(FRASE_CONFLITO_CRIACAO_RASCUNHO_SHOPEE)).toBeTruthy();
    expect(cabecalhos()).toEqual(['Campo', 'Salvo agora', 'Sua alteração']);
    expect(celulas('category_id')).toEqual(['Categoria', 'Categoria #100090', 'Categoria #100087']);
    // «Sua alteração» is the FORM's list (#1911 P13) — none on this retry.
    expect(celulas('attributes')).toEqual(['Atributos', '2 atributo(s)', '(nenhum)']);
  });

  it('#1911 P13: «Sua alteração» de `attributes` conta a lista EDITADA — nunca a guardada ⟷ QUASE-PAR: «Quando você abriu» conta a guardada', () => {
    const base: CamposRascunhoShopee = {
      ...BASE,
      attributes: [{ attribute_id: 100408, attribute_value_list: [{ value_id: 2498 }] }],
    };
    show({
      conflito: {
        linkDocId: LINK,
        operacao: 'atualizar',
        conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.attributes, atual: [] }],
      },
      edicao: {
        ...EDICAO,
        base,
        atual: {
          ...formularioDoRascunhoShopee(base),
          attributes: [
            { attribute_id: 100408, attribute_value_list: [{ value_id: 2530 }] },
            {
              attribute_id: 101237,
              attribute_value_list: [{ value_id: 0, original_value_name: 'Fabricante Exemplo' }],
            },
            {
              attribute_id: 101029,
              attribute_value_list: [{ value_id: 0, original_value_name: '1.5', value_unit: 'KG' }],
            },
          ],
        },
      },
    });
    expect(celulas('attributes')).toEqual([
      'Atributos',
      '1 atributo(s)',
      '(nenhum)',
      '3 atributo(s)',
    ]);
  });

  it('QUASE-PAR: `logistic_info` não é campo do formulário — «Sua alteração» é o valor guardado', () => {
    show({
      conflito: {
        linkDocId: LINK,
        operacao: 'atualizar',
        conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.logisticInfo, atual: null }],
      },
      edicao: { ...EDICAO, base: { ...BASE, logistic_info: [] } },
    });
    // The held list reads «definida» in both columns; the form's (absent) would be «(automática)».
    expect(celulas('logistic_info').slice(1)).toEqual(['definida', '(automática)', 'definida']);
  });
});

describe('ConflitoRascunhoShopeeModal — the buttons', () => {
  it('each button fires ITS callback — and none submits the enclosing produto form', () => {
    const cb = show();
    fireEvent.click(botao('Cancelar'));
    expect(cb.onCancelar).toHaveBeenCalledTimes(1);
    fireEvent.click(botao('Usar o que está salvo'));
    expect(cb.onUsarOQueEstaSalvo).toHaveBeenCalledTimes(1);
    fireEvent.click(botao('Salvar mesmo assim'));
    expect(cb.onSalvarMesmoAssim).toHaveBeenCalledTimes(1);
    expect(cb.onSubmit).not.toHaveBeenCalled();
  });

  it('the snapshot lacks the stored draft ⇒ both resolving buttons are disabled and it says why', () => {
    const cb = show({ servidorCarregado: false });
    expect(screen.getByText(FRASE_RASCUNHO_CARREGANDO_SHOPEE)).toBeTruthy();
    expect((botao('Usar o que está salvo') as HTMLButtonElement).disabled).toBe(true);
    expect((botao('Salvar mesmo assim') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(botao('Salvar mesmo assim'));
    expect(cb.onSalvarMesmoAssim).not.toHaveBeenCalled();
    // Cancelar always closes.
    expect((botao('Cancelar') as HTMLButtonElement).disabled).toBe(false);
  });

  it('NEAR-MISS: loaded ⇒ both enabled, no loading sentence', () => {
    show({ servidorCarregado: true });
    expect(screen.queryByText(FRASE_RASCUNHO_CARREGANDO_SHOPEE)).toBeNull();
    expect((botao('Usar o que está salvo') as HTMLButtonElement).disabled).toBe(false);
    expect((botao('Salvar mesmo assim') as HTMLButtonElement).disabled).toBe(false);
  });

  it('while the resend is in flight: «Salvar mesmo assim» spins, the others are disabled', () => {
    show({ salvando: true });
    expect(botao('Salvar mesmo assim').getAttribute('data-loading')).toBe('true');
    expect((botao('Cancelar') as HTMLButtonElement).disabled).toBe(true);
    expect((botao('Usar o que está salvo') as HTMLButtonElement).disabled).toBe(true);
  });

  it('NEAR-MISS: idle ⇒ no spinner', () => {
    show({ salvando: false });
    expect(botao('Salvar mesmo assim').getAttribute('data-loading')).toBeNull();
  });

  it('an entry gone (`edicao: null`) still renders the stored side without crashing', () => {
    show({ edicao: null });
    expect(celulas('item_name')).toEqual(['Título', '—', 'Camiseta verde', '—']);
  });
});

describe('textoDoValorDoRascunhoShopee — display only, total over `unknown`', () => {
  it('reads each field’s stored shapes', () => {
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.itemName, 'Camiseta')).toBe(
      'Camiseta',
    );
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.itemName, '  ')).toBe('(vazio)');
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.itemName, null)).toBe('(vazio)');
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.description, null)).toBe(
      '(a descrição do produto)',
    );
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.description, 'Algodão')).toBe(
      'Algodão',
    );
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.categoryId, 100087)).toBe(
      'Categoria #100087',
    );
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.categoryId, null)).toBe('(nenhuma)');
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.marca, null)).toBe(
      'Nenhuma marca escolhida',
    );
    expect(
      textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.marca, {
        brand_id: 0,
        original_brand_name: null,
      }),
    ).toBe('Sem marca (No Brand)');
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.marca, { brand_id: 77 })).toBe(
      'Marca 77',
    );
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.attributes, [])).toBe('(nenhum)');
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.logisticInfo, null)).toBe(
      '(automática)',
    );
  });

  it('a shape this build does not know reads "(valor não reconhecido)" — never a crash', () => {
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.itemName, 12)).toBe(
      '(valor não reconhecido)',
    );
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.categoryId, '100087')).toBe(
      '(valor não reconhecido)',
    );
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.marca, { brand_id: 'x' })).toBe(
      '(valor não reconhecido)',
    );
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.marca, 'Nike')).toBe(
      '(valor não reconhecido)',
    );
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.attributes, { a: 1 })).toBe(
      '(valor não reconhecido)',
    );
  });
});

describe('ConflitoRascunhoShopeeModal — rows refreshed instead of a re-send (R1-rule7#0)', () => {
  it('`renovado`: says the draft moved again and NOTHING was sent, above the refreshed rows', () => {
    show({
      conflito: {
        ...EDITADO,
        conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta (terceira aba)' }],
        renovado: true,
      },
    });
    expect(screen.getByTestId('shopee-rascunho-conflito-renovado').textContent).toBe(
      FRASE_CONFLITO_RENOVADO_RASCUNHO_SHOPEE,
    );
    expect(FRASE_CONFLITO_RENOVADO_RASCUNHO_SHOPEE).toContain('nada foi enviado');
    expect(celulas('item_name')).toEqual([
      'Título',
      'Camiseta',
      'Camiseta (terceira aba)',
      'Camiseta azul',
    ]);
  });

  it('NEAR-MISS: the 409’s own rows (no `renovado`) say nothing of the sort', () => {
    show();
    expect(screen.queryByTestId('shopee-rascunho-conflito-renovado')).toBeNull();
  });
});
