import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ProdutoShopeeLink } from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  MOTIVO_ANUNCIO_SHOPEE,
  TEXTO_MOTIVO_ANUNCIO_SHOPEE,
  textoDaEtapaShopee,
} from '@/lib/shopee/anuncioProduto';

import { RecusasAnuncioShopee } from './RecusasAnuncioShopee';

/**
 * The stored-refusal panel (#1911 rev. 2a #12): each `falhaPublicacao` row
 * reads the tab's OWN copy of its `motivo` first — a draft's refused
 * `add_item` is stamped here, and Shopee's English prose must not be what
 * stays on screen once the outcome panel is gone — and its stored `mensagem`
 * only as the fallback. Rendered for REAL over the REAL copy map.
 */

/** MILLISECONDS — the instant the stock skip set is read against (a fixture). */
const AGORA = Date.UTC(2026, 9, 28, 12, 0, 0);

/** A link carrying only a stored failed publish — the stock/price halves are absent (nothing else shows). */
function link(problemas: unknown, mensagem: unknown = null): ProdutoShopeeLink {
  return {
    item_id: null,
    integracaoId: 'int-1',
    falhaPublicacao: { em: AGORA - 60_000, etapa: 'add_item', mensagem, problemas },
  } as unknown as ProdutoShopeeLink;
}

function show(l: ProdutoShopeeLink) {
  render(
    <MantineTestProvider>
      <RecusasAnuncioShopee link={l} agoraMs={AGORA} />
    </MantineTestProvider>,
  );
}

const itens = () =>
  within(screen.getByText('A última publicação falhou').closest('.mantine-Alert-root')!)
    .queryAllByRole('listitem')
    .map((li) => li.textContent);

const PROSA_DA_SHOPEE =
  'The item is too similar to an existing item in your shop. error_repeated_mtsku';

describe('RecusasAnuncioShopee — a stored refusal row reads the motivo copy first (rev. 2a #12)', () => {
  it('`anuncio-semelhante-existente` (Shopee’s duplicate refusal) ⇒ the tab’s copy, NEVER the English prose', () => {
    show(
      link([
        {
          campo: 'item_sku',
          motivo: MOTIVO_ANUNCIO_SHOPEE.anuncioSemelhanteExistente,
          mensagem: PROSA_DA_SHOPEE,
        },
      ]),
    );
    expect(itens()).toEqual([
      TEXTO_MOTIVO_ANUNCIO_SHOPEE[MOTIVO_ANUNCIO_SHOPEE.anuncioSemelhanteExistente],
    ]);
    expect(screen.queryByText(PROSA_DA_SHOPEE)).toBeNull();
  });

  it('NEAR-MISS: a motivo the tab does not word (`listagem-removida`) keeps its stored sentence', () => {
    show(link([{ campo: null, motivo: 'listagem-removida', mensagem: 'O anúncio foi removido.' }]));
    expect(itens()).toEqual(['O anúncio foi removido.']);
  });

  it('NEAR-MISS: a renamed slug falls back to the stored sentence — never a wrong row', () => {
    show(
      link([
        {
          campo: 'item_sku',
          motivo: 'anuncio-semelhante-existente-v2',
          mensagem: 'Sentença guardada.',
        },
      ]),
    );
    expect(itens()).toEqual(['Sentença guardada.']);
  });

  it('rows keep their order; a row with neither copy nor sentence is dropped; a non-string motivo is ignored', () => {
    show(
      link([
        { motivo: 'outro', mensagem: 'Primeira.' },
        { motivo: 'outro', mensagem: '   ' },
        { motivo: 42, mensagem: 'Terceira.' },
        { motivo: MOTIVO_ANUNCIO_SHOPEE.anuncioSemelhanteExistente, mensagem: null },
        'não é uma linha',
      ]),
    );
    expect(itens()).toEqual([
      'Primeira.',
      'Terceira.',
      TEXTO_MOTIVO_ANUNCIO_SHOPEE[MOTIVO_ANUNCIO_SHOPEE.anuncioSemelhanteExistente],
    ]);
  });

  it('#2015: two stored `logistica-nao-confirmada` rows ⇒ the copy ONCE ⟷ NEAR-MISS the `logistica-sem-canal` row beside them stays', () => {
    const SEM_CANAL = 'Nenhum canal obrigatório da loja pôde ser habilitado para este item.';
    show(
      link([
        {
          campo: 'logistic_info',
          motivo: MOTIVO_ANUNCIO_SHOPEE.logisticaNaoConfirmada,
          mensagem: 'O canal obrigatório 80003 precisa de um tamanho.',
        },
        {
          campo: 'logistic_info',
          motivo: MOTIVO_ANUNCIO_SHOPEE.logisticaNaoConfirmada,
          mensagem: 'O canal obrigatório 80007 precisa de uma tarifa de frete.',
        },
        { campo: 'logistic_info', motivo: 'logistica-sem-canal', mensagem: SEM_CANAL },
      ]),
    );
    expect(itens()).toEqual([
      TEXTO_MOTIVO_ANUNCIO_SHOPEE[MOTIVO_ANUNCIO_SHOPEE.logisticaNaoConfirmada],
      SEM_CANAL,
    ]);
  });

  it('no row at all ⇒ the stored summary sentence, as before', () => {
    show(link([], 'A Shopee recusou o anúncio.'));
    expect(itens()).toEqual([]);
    expect(screen.getByText('A Shopee recusou o anúncio.')).toBeTruthy();
  });

  it('NEAR-MISS: no stored failure ⇒ nothing renders', () => {
    const { container } = render(
      <MantineTestProvider>
        <RecusasAnuncioShopee
          link={{ item_id: 1, integracaoId: 'int-1' } as unknown as ProdutoShopeeLink}
          agoraMs={AGORA}
        />
      </MantineTestProvider>,
    );
    // (The provider's own <style> tags sit in the container: count the panel's alerts instead.)
    expect(container.querySelector('.mantine-Alert-root')).toBeNull();
    expect(screen.queryByText('A última publicação falhou')).toBeNull();
  });
});

describe('RecusasAnuncioShopee — the stored etapa is worded, never printed raw (#1911 P11 review, R8-copy#15)', () => {
  const alerta = () =>
    screen.getByText('A última publicação falhou').closest('.mantine-Alert-root')!;
  function comEtapa(etapa: unknown, itemId: number | null = null): ProdutoShopeeLink {
    return {
      item_id: itemId,
      integracaoId: 'int-1',
      falhaPublicacao: { em: AGORA - 60_000, etapa, mensagem: 'Recusado.', problemas: [] },
    } as unknown as ProdutoShopeeLink;
  }

  it('a DRAFT’s refused `add_item` reads the outcome panel’s own draft wording — no raw code, no «Reverificar» (a draft has none)', () => {
    show(comEtapa('add_item'));
    expect(alerta().textContent).toContain(textoDaEtapaShopee('add_item', { ehRascunho: true }));
    expect(alerta().textContent).not.toContain('add_item');
    expect(alerta().textContent).not.toContain('Reverificar');
  });

  it('NEAR-MISS: a LIVE listing’s stored etapa keeps the live caution, «Reverificar» included', () => {
    show(comEtapa('update_item', 1000001));
    expect(alerta().textContent).toContain(
      textoDaEtapaShopee('update_item', { ehRascunho: false }),
    );
    expect(alerta().textContent).toContain('Reverificar');
    expect(alerta().textContent).not.toContain('update_item');
  });

  it.each(['etapa-nova', 'constructor'])(
    'NEAR-MISS: an etapa this build does not know (%s) reads the neutral fallback, never the code',
    (etapa) => {
      show(comEtapa(etapa));
      expect(alerta().textContent).toContain(textoDaEtapaShopee(etapa, { ehRascunho: true }));
      expect(alerta().textContent).toContain('uma etapa que esta tela ainda não descreve');
      expect(alerta().textContent).not.toContain(etapa);
    },
  );

  it('no stored etapa ⇒ no etapa line at all', () => {
    show(comEtapa(null));
    expect(alerta().textContent).not.toContain('Recusada na etapa');
  });
});
