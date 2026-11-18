import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  ALVO_EDICAO_SHOPEE,
  CAMPO_RASCUNHO_SHOPEE,
  type CamposRascunhoShopee,
} from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  FRASE_CONFLITO_ANUNCIO_SHOPEE,
  FRASE_CONFLITO_CRIACAO_RASCUNHO_SHOPEE,
  FRASE_CONFLITO_RASCUNHO_SHOPEE,
  FRASE_RASCUNHO_CARREGANDO_SHOPEE,
  TITULO_CONFLITO_ANUNCIO_SHOPEE,
  TITULO_CONFLITO_RASCUNHO_SHOPEE,
} from '@/lib/shopee/anuncioProduto';
import { formularioDoRascunhoShopee, type EdicaoRascunhoShopee } from '@/lib/shopee/rascunho';

import {
  ConflitoRascunhoShopeeModal,
  FRASE_CONFLITO_RENOVADO_ANUNCIO_SHOPEE,
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
  logistic_info: null,
};

/* #1911 P16 — fixture channel ids (no real channel). */
const A = 90003;
const B = 90005;
const ligado = (logistic_id: number, is_free: boolean | null = false) => ({
  logistic_id,
  enabled: true,
  is_free,
});
const desligado = (logistic_id: number, is_free: boolean | null = false) => ({
  logistic_id,
  enabled: false,
  is_free,
});

const EDICAO: EdicaoRascunhoShopee = {
  linkDocId: LINK,
  contaId: 'int-1',
  novo: false,
  alvo: ALVO_EDICAO_SHOPEE.rascunho,
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

  // Was: 'QUASE-PAR: `logistic_info` não é campo do formulário — «Sua alteração» é o valor guardado'
  // (before #1911 P16 the form did not edit it).
  it('#1911 P16 — PAR: `logistic_info` é campo do formulário — «Sua alteração» é a lista do FORMULÁRIO ⟷ QUASE-PAR: «Quando você abriu» é a guardada', () => {
    const base: CamposRascunhoShopee = { ...BASE, logistic_info: [ligado(A), desligado(B)] };
    show({
      conflito: {
        linkDocId: LINK,
        operacao: 'atualizar',
        conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.logisticInfo, atual: null }],
      },
      edicao: {
        ...EDICAO,
        base,
        atual: { ...formularioDoRascunhoShopee(base), logistic_info: [ligado(A), ligado(B, true)] },
      },
    });
    expect(celulas('logistic_info')).toEqual([
      'Logística',
      'Canal 90003: ligado; Canal 90005: desligado',
      '(automática)',
      'Canal 90003: ligado; Canal 90005: ligado, frete grátis',
    ]);
  });

  it('#1911 P16 — PAR (D16-9): num 409 de CRIAÇÃO a linha «Logística» mostra em «Sua alteração» o valor de «Salvo agora» — o reenvio não a nomeia ⟷ QUASE-PAR: num de EDIÇÃO, a lista do formulário', () => {
    const outraAba = [ligado(A, true)];
    const conflitos = [
      { campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta verde' },
      { campo: CAMPO_RASCUNHO_SHOPEE.logisticInfo, atual: outraAba },
    ];
    // A new draft's form holds «Automática» — no choice the operator made.
    show({
      conflito: { linkDocId: LINK, operacao: 'criar', conflitos },
      edicao: { ...EDICAO, novo: true },
    });
    expect(celulas('logistic_info')).toEqual([
      'Logística',
      'Canal 90003: ligado, frete grátis',
      'Canal 90003: ligado, frete grátis',
    ]);
    // The title row still reads the operator's form.
    expect(celulas('item_name')).toEqual(['Título', 'Camiseta verde', 'Camiseta azul']);
    cleanup();

    // QUASE-PAR: the same rows on an EDIT read the form's «Automática».
    show({ conflito: { linkDocId: LINK, operacao: 'atualizar', conflitos } });
    expect(celulas('logistic_info')).toEqual([
      'Logística',
      '(automática)',
      'Canal 90003: ligado, frete grátis',
      '(automática)',
    ]);
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
    // #1911 P16 (Q-B): one line per channel, by id.
    expect(
      textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.logisticInfo, [
        ligado(A, true),
        desligado(B),
      ]),
    ).toBe('Canal 90003: ligado, frete grátis; Canal 90005: desligado');
    // A stamped empty list is a list with no channel — never «(automática)».
    expect(textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.logisticInfo, [])).toBe('(vazio)');
    // A stored `is_free: null` reads unticked.
    expect(
      textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.logisticInfo, [ligado(A, null)]),
    ).toBe('Canal 90003: ligado');
  });

  it('#1911 P16 (Q-B) — QUASE-PAR: duas listas com a MESMA contagem de ligados — o frete grátis trocado, um par ligado/desligado invertido — dão textos DIFERENTES ⟷ PAR: a mesma lista com as chaves (ou as entradas) em outra ordem dá o MESMO texto', () => {
    const texto = (lista: unknown) =>
      textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.logisticInfo, lista);
    const guardada = texto([ligado(A), ligado(B)]);
    // QUASE-PAR: two ON each time — a count would read «2 de 2» for both.
    expect(texto([ligado(A), ligado(B, true)])).not.toBe(guardada);
    // QUASE-PAR: one ON each time — A on/B off vs A off/B on.
    expect(texto([ligado(A), desligado(B)])).not.toBe(texto([desligado(A), ligado(B)]));
    expect(texto([ligado(A), desligado(B)])).toBe('Canal 90003: ligado; Canal 90005: desligado');
    expect(texto([desligado(A), ligado(B)])).toBe('Canal 90003: desligado; Canal 90005: ligado');
    // PAR: the keys in another order, and the entries in another order, read the same.
    expect(
      texto([
        { is_free: false, enabled: true, logistic_id: A },
        { enabled: true, is_free: false, logistic_id: B },
      ]),
    ).toBe(guardada);
    expect(texto([ligado(B), ligado(A)])).toBe(guardada);
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
    // #1911 P16: a non-list, and a list with ONE entry this build cannot read.
    for (const valor of [
      'automatica',
      { logistic_id: A, enabled: true, is_free: false },
      [ligado(A), { logistic_id: '90005', enabled: true, is_free: false }],
      [{ logistic_id: A, enabled: 'sim', is_free: false }],
      [{ logistic_id: A, enabled: true, is_free: 'nao' }],
      [{ logistic_id: A, enabled: true }],
      [null],
    ]) {
      expect(
        textoDoValorDoRascunhoShopee(CAMPO_RASCUNHO_SHOPEE.logisticInfo, valor),
        JSON.stringify(valor),
      ).toBe('(valor não reconhecido)');
    }
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

describe('ConflitoRascunhoShopeeModal — a PUBLISHED listing’s entry (alvo anuncio)', () => {
  const ANUNCIO: EdicaoRascunhoShopee = { ...EDICAO, alvo: ALVO_EDICAO_SHOPEE.anuncio };

  it('says «Anúncio alterado» and the listing alert — never the draft copy', () => {
    show({ edicao: ANUNCIO });
    expect(screen.getByText(TITULO_CONFLITO_ANUNCIO_SHOPEE)).toBeTruthy();
    expect(screen.getByText(FRASE_CONFLITO_ANUNCIO_SHOPEE)).toBeTruthy();
    expect(screen.queryByText(TITULO_CONFLITO_RASCUNHO_SHOPEE)).toBeNull();
    expect(screen.queryByText(FRASE_CONFLITO_RASCUNHO_SHOPEE)).toBeNull();
  });

  it('NEAR-MISS: the same conflict on a DRAFT entry keeps the draft copy', () => {
    show({ edicao: EDICAO });
    expect(screen.getByText(TITULO_CONFLITO_RASCUNHO_SHOPEE)).toBeTruthy();
    expect(screen.queryByText(TITULO_CONFLITO_ANUNCIO_SHOPEE)).toBeNull();
  });

  it('the renewed rows say the listing moved again, and nothing was sent', () => {
    show({ edicao: ANUNCIO, conflito: { ...EDITADO, renovado: true } });
    const aviso = screen.getByTestId('shopee-rascunho-conflito-renovado');
    expect(aviso.textContent).toBe(FRASE_CONFLITO_RENOVADO_ANUNCIO_SHOPEE);
    expect(aviso.textContent).not.toBe(FRASE_CONFLITO_RENOVADO_RASCUNHO_SHOPEE);
  });

  it('the resolving buttons are enabled and fire their callbacks', () => {
    const cb = show({ edicao: ANUNCIO });
    expect((botao('Salvar mesmo assim') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(botao('Usar o que está salvo'));
    expect(cb.onUsarOQueEstaSalvo).toHaveBeenCalledTimes(1);
  });
});
