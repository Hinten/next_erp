import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ProdutoShopeeLink } from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  FRASE_FORMULARIO_SUJO_BLOQUEIA_ACOES_SHOPEE,
  ROTULO_DESCARTAR_EDICOES_SHOPEE,
} from '@/lib/shopee/anuncioProduto';

import {
  AcoesAnuncioShopee,
  type AcoesShopee,
  type EdicaoDoAnuncioNaTela,
} from './AcoesAnuncioShopee';

/**
 * The action row of a PUBLISHED listing (PR3): «Republicar» is gated by THIS link's dirty form,
 * and «Descartar alterações não enviadas» shows only for a pending, still-editable listing.
 */

const CONTA = 'int-1';
const LINK_ID = 'anun0000000000000001';

/** A live, published, ordinary listing — editable. */
function publicado(extra: Record<string, unknown> = {}): ProdutoShopeeLink {
  return {
    item_id: 987654321,
    estadoAnuncio: 'ativo',
    ...extra,
  } as unknown as ProdutoShopeeLink;
}

/** A listing with an ERP-side edit saved and not yet sent (revision 4). */
const PENDENTE = { edicaoErpPendenteEm: 1_700_000_000_000, edicaoErpRevisao: 4 };

const LIMPA: EdicaoDoAnuncioNaTela = { suja: false, aguardandoEco: false };

function acoesBase(over: Partial<AcoesShopee> = {}): AcoesShopee {
  return {
    permitidas: true,
    bloqueadas: false,
    emVoo: null,
    desfechoDe: () => null,
    enderecavel: () => true,
    pedirPausa: vi.fn(),
    reativar: vi.fn(),
    reverificar: vi.fn(),
    pedirDescarteDasEdicoes: vi.fn(),
    republicar: vi.fn(),
    abrirKit: vi.fn(),
    incertoDe: () => null,
    repetirKit: vi.fn(),
    kitAberto: () => false,
    alternarKit: vi.fn(),
    ofereceKitNativo: () => false,
    ...over,
  };
}

function show(
  link: ProdutoShopeeLink,
  edicao: EdicaoDoAnuncioNaTela | null | undefined,
  acoes: AcoesShopee = acoesBase(),
) {
  render(
    <MantineTestProvider>
      <AcoesAnuncioShopee
        contaId={CONTA}
        linkDocId={LINK_ID}
        link={link}
        acoes={acoes}
        {...(edicao === undefined ? {} : { edicao })}
      />
    </MantineTestProvider>,
  );
  return acoes;
}

const republicar = () => screen.getByRole('button', { name: 'Republicar' }) as HTMLButtonElement;
const descartar = () => screen.queryByTestId(`shopee-descartar-edicoes-${LINK_ID}`);

describe('AcoesAnuncioShopee — «Republicar» while the edit form is dirty', () => {
  it('a dirty form disables it and says why in visible text (a disabled button is not focusable)', () => {
    show(publicado(), { suja: true, aguardandoEco: false });
    expect(republicar().disabled).toBe(true);
    expect(screen.getByTestId(`shopee-acoes-sujo-${LINK_ID}`).textContent).toBe(
      FRASE_FORMULARIO_SUJO_BLOQUEIA_ACOES_SHOPEE,
    );
  });

  it('NEAR-MISS: a clean form (or no edit at all) leaves it enabled, with no sentence', () => {
    for (const edicao of [LIMPA, null, undefined]) {
      document.body.innerHTML = '';
      show(publicado(), edicao);
      expect(republicar().disabled).toBe(false);
      expect(screen.queryByTestId(`shopee-acoes-sujo-${LINK_ID}`)).toBeNull();
    }
  });

  it('a save awaiting its echo does NOT disable it — the server already holds the edit', () => {
    show(publicado(), { suja: false, aguardandoEco: true });
    expect(republicar().disabled).toBe(false);
  });

  it('a click sends the republish for this link', () => {
    const acoes = show(publicado(), LIMPA);
    fireEvent.click(republicar());
    expect(acoes.republicar).toHaveBeenCalledWith(CONTA, LINK_ID);
  });
});

describe('AcoesAnuncioShopee — «Descartar alterações não enviadas»', () => {
  it('shows for a pending, editable listing and asks for the confirmation of THIS link', () => {
    const acoes = show(publicado(PENDENTE), LIMPA);
    const botao = screen.getByRole('button', { name: ROTULO_DESCARTAR_EDICOES_SHOPEE });
    expect((botao as HTMLButtonElement).disabled).toBe(false);
    expect(botao.getAttribute('type')).toBe('button');
    fireEvent.click(botao);
    expect(acoes.pedirDescarteDasEdicoes).toHaveBeenCalledWith(CONTA, LINK_ID);
  });

  it('NEAR-MISS: nothing pending (absent, or `0`) ⇒ no button', () => {
    show(publicado(), LIMPA);
    expect(descartar()).toBeNull();
    document.body.innerHTML = '';
    show(publicado({ edicaoErpPendenteEm: 0, edicaoErpRevisao: 4 }), LIMPA);
    expect(descartar()).toBeNull();
  });

  it('NEAR-MISS: pending but the link is no longer editable (a kit nativo) ⇒ no button', () => {
    show(publicado({ ...PENDENTE, kitNativo: true }), LIMPA);
    expect(descartar()).toBeNull();
  });

  it('NEAR-MISS: a link with no edit form (`edicao: null`) ⇒ no button', () => {
    show(publicado(PENDENTE), null);
    expect(descartar()).toBeNull();
  });

  it.each([
    ['the form is dirty', { suja: true, aguardandoEco: false }, acoesBase()],
    ['a save awaits its echo', { suja: false, aguardandoEco: true }, acoesBase()],
    ['a write is in flight', LIMPA, acoesBase({ bloqueadas: true })],
  ])('is disabled while %s', (_motivo, edicao, acoes) => {
    show(publicado(PENDENTE), edicao, acoes);
    expect((descartar() as HTMLButtonElement).disabled).toBe(true);
  });

  it('is disabled when the link carries no readable revision — there is nothing the server could compare', () => {
    show(publicado({ edicaoErpPendenteEm: 1_700_000_000_000 }), LIMPA);
    expect((descartar() as HTMLButtonElement).disabled).toBe(true);
  });

  it('spins while its own write is in flight and not while another link’s is', () => {
    show(
      publicado(PENDENTE),
      LIMPA,
      acoesBase({ emVoo: { linkDocId: LINK_ID, acao: 'descartar-edicoes' } }),
    );
    expect(descartar()?.hasAttribute('data-loading')).toBe(true);
    document.body.innerHTML = '';
    show(
      publicado(PENDENTE),
      LIMPA,
      acoesBase({ emVoo: { linkDocId: 'outro', acao: 'descartar-edicoes' } }),
    );
    expect(descartar()?.hasAttribute('data-loading')).toBe(false);
  });
});
