import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import {
  ESTADO_PUBLICACAO_ML,
  ML_CAUSA_TIPO,
  type MlCausa,
  type ProdutoMercadoLivreLink,
} from '@delfrance/schemas';

import { linkFixture } from '@/lib/mercado-livre/linkFixture';
import { ListingStatusStrip } from './ListingStatusStrip';

const causaFixture = (over: Partial<MlCausa> = {}): MlCausa => ({
  code: null,
  causaId: null,
  tipo: ML_CAUSA_TIPO.erro,
  departamento: null,
  mensagem: 'algo deu errado',
  referencias: [],
  campos: [],
  ...over,
});

function renderStrip(over: Partial<ProdutoMercadoLivreLink> = {}, onReverificar = vi.fn()) {
  render(
    <MantineProvider env="test">
      <ListingStatusStrip
        link={linkFixture({ status: null, ...over })}
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

  it('falls back to the raw errors when the doc predates structured causes', () => {
    // A Flutter-written doc, or one this app stamped before #1109, has
    // `causas: null` and must keep showing what it does have.
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.erro,
      errors: ['ML 400: Validation error'],
      causas: null,
    });
    expect(screen.getByText('ML 400: Validation error')).toBeDefined();
  });

  it('shows a cause with no control above the form, with its ML code', () => {
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.erro,
      errors: ['warning · shipping.me2_adoption_mandatory — …'],
      causas: [
        causaFixture({
          code: 'moderations.seller.not_authorized',
          mensagem: 'Marca não autorizada',
          referencias: ['item.seller_id'],
        }),
      ],
    });
    const alerta = screen.getByTestId('ml-causas-gerais');
    expect(alerta.textContent).toContain('Marca não autorizada');
    // The raw ML reference rides along: an unmapped path is still actionable.
    expect(alerta.textContent).toContain('item.seller_id');
    expect(alerta.textContent).toContain('moderations.seller.not_authorized');
  });

  it('does NOT repeat a cause the control already shows', () => {
    // A single-field cause belongs on its input; echoing it here would make one
    // rejection look like two.
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.erro,
      causas: [causaFixture({ mensagem: 'Categoria inválida', campos: ['category_id'] })],
    });
    expect(screen.queryByTestId('ml-causas-gerais')).toBeNull();
  });

  it('keeps ML-applied warnings out of the red alert', () => {
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.publicado,
      causas: [
        causaFixture({
          tipo: ML_CAUSA_TIPO.aviso,
          code: 'shipping.me2_adoption_mandatory',
          mensagem: 'ME2 adoption is mandatory for the user',
        }),
      ],
    });
    expect(screen.queryByTestId('ml-causas-gerais')).toBeNull();
    expect(screen.getByTestId('ml-causas-avisos').textContent).toContain('ME2 adoption');
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
