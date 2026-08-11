import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ESTADO_PUBLICACAO_ML, type ProdutoMercadoLivreLink } from '@delfrance/schemas';

import { ListingStatusStrip } from './ListingStatusStrip';

function link(over: Partial<ProdutoMercadoLivreLink> = {}): ProdutoMercadoLivreLink {
  return {
    contaOuterRef: 'documents/integracao/conta-1',
    channels: ['marketplace'],
    estado: ESTADO_PUBLICACAO_ML.publicado,
    status: null,
    sub_status: null,
    id: 'MLB777',
    sku: null,
    descricao: null,
    site_id: 'MLB',
    title: 'Camiseta',
    category_id: 'MLB31447',
    condition: 'new',
    listing_type_id: 'gold_special',
    crossdocking: null,
    freteGratis: false,
    precoPublicado: 79.9,
    tarifaFrete: null,
    comissao: null,
    isUserProductModel: false,
    video_id: null,
    attributes: null,
    errors: null,
    ultimaModificacao: null,
    dataCadastro: null,
    ...over,
  } as ProdutoMercadoLivreLink;
}

function renderStrip(over: Partial<ProdutoMercadoLivreLink> = {}, onReverificar = vi.fn()) {
  render(
    <MantineProvider env="test">
      <ListingStatusStrip
        link={link(over)}
        canWrite
        disabled={false}
        rechecking={false}
        onReverificar={onReverificar}
      />
    </MantineProvider>,
  );
  return onReverificar;
}

describe('ListingStatusStrip', () => {
  it('keeps the assertions the existing e2e spec depends on', () => {
    renderStrip();
    expect(screen.getByText('Anúncio MLB777')).toBeDefined();
    expect(screen.getByText('Publicado')).toBeDefined();
  });

  it('names the listing model, because the two behave differently on publish', () => {
    renderStrip({ isUserProductModel: false });
    expect(screen.getByText('Variações do anúncio')).toBeDefined();
  });

  it('marks a User-Products listing distinctly', () => {
    renderStrip({ isUserProductModel: true, id: '6264141844942250' });
    expect(screen.getByText('User Products')).toBeDefined();
  });

  it('links to the live listing for a legacy listing', () => {
    renderStrip();
    const anchor = screen.getByRole('link', { name: 'ver no Mercado Livre' });
    expect(anchor.getAttribute('href')).toBe('https://produto.mercadolivre.com.br/MLB-777');
    // Opening in a new tab also dodges the unsaved-changes guard, which skips
    // target="_blank" anchors.
    expect(anchor.getAttribute('target')).toBe('_blank');
  });

  it('offers no link for a User-Products family, whose id is not an item', () => {
    // `link.id` is the family id there; building an MLB URL from it would 404.
    renderStrip({ isUserProductModel: true, id: '6264141844942250' });
    expect(screen.queryByRole('link', { name: 'ver no Mercado Livre' })).toBeNull();
  });

  it("surfaces ML's raw status and sub_status", () => {
    // `paused` alone is the seller's own pause; `paused` + `out_of_stock` is ML
    // reacting to zero stock, and only the second resolves itself.
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.pausado,
      status: 'paused',
      sub_status: ['out_of_stock'],
    });
    expect(screen.getByText(/paused · out_of_stock/)).toBeDefined();
  });

  it('shows persisted errors under a neutral title', () => {
    // errors[] is written by publish, the price sync AND the stock sender, so
    // the title must not blame any one of them (#781).
    renderStrip({ estado: ESTADO_PUBLICACAO_ML.erro, errors: ['item.attributes.required'] });
    expect(screen.getByText('Última falha do Mercado Livre')).toBeDefined();
    expect(screen.getByText('item.attributes.required')).toBeDefined();
  });

  it('offers the latch escape hatch only for a PUBLISHED listing in error', () => {
    renderStrip({ estado: ESTADO_PUBLICACAO_ML.erro, id: 'MLB777' });
    expect(screen.getByRole('button', { name: 'Reverificar anúncio' })).toBeDefined();
  });

  it('does not offer it for a draft that merely failed validation', () => {
    renderStrip({ estado: ESTADO_PUBLICACAO_ML.erro, id: null });
    expect(screen.queryByRole('button', { name: 'Reverificar anúncio' })).toBeNull();
  });
});
