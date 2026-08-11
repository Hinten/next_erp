import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ESTADO_PUBLICACAO_ML, type ProdutoMercadoLivreLink } from '@delfrance/schemas';

import { ListingDetails } from './ListingDetails';

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
    title: 'Camiseta Básica',
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

function renderDetails(over: Partial<ProdutoMercadoLivreLink> = {}, fotos: number | null = 3) {
  render(
    <MantineProvider env="test">
      <ListingDetails link={link(over)} produtoFotoCount={fotos} />
    </MantineProvider>,
  );
}

describe('ListingDetails', () => {
  it('surfaces the stored fields the screen never showed', () => {
    renderDetails({
      descricao: 'Uma descrição própria do anúncio',
      video_id: 'ABC123',
      crossdocking: 3,
    });
    expect(screen.getByText('Camiseta Básica')).toBeDefined();
    expect(screen.getByText('gold_special')).toBeDefined();
    expect(screen.getByText('Uma descrição própria do anúncio')).toBeDefined();
    expect(screen.getByText('ABC123')).toBeDefined();
    expect(screen.getByText('3 dia(s)')).toBeDefined();
  });

  it('NEVER renders a labelled "Tipo de anúncio" control', () => {
    // The e2e spec proves the first-publish Select is gone by asserting
    // getByLabel('Tipo de anúncio') has count 0 on a published listing. A
    // <label> association or aria-label here would resurrect that locator and
    // fail the spec while looking harmless in review.
    renderDetails();
    expect(screen.queryByLabelText('Tipo de anúncio')).toBeNull();
    // …but the operator can still read the value.
    expect(screen.getByText('Tipo de anúncio')).toBeDefined();
  });

  it('says where the description comes from when the listing has none', () => {
    renderDetails({ descricao: null });
    expect(
      screen.getByText('Sem descrição própria — a publicação usa a descrição do produto.'),
    ).toBeDefined();
  });

  it('maps the channels presets to their labels', () => {
    renderDetails({ channels: ['marketplace', 'mshops'] });
    expect(screen.getByText('Todos')).toBeDefined();
  });

  it('warns BEFORE publish that no photos means a blocked publish', () => {
    // publishCore raises "produto sem fotos" as a 422; catching it here saves
    // the operator a rejection they cannot read.
    renderDetails({}, 0);
    expect(screen.getByText(/Produto sem fotos/)).toBeDefined();
  });

  it('warns that ML silently drops photos past the tenth', () => {
    renderDetails({}, 14);
    expect(screen.getByText(/no máximo 10 fotos/)).toBeDefined();
  });

  it('shows neither warning for a normal photo count', () => {
    renderDetails({}, 4);
    expect(screen.queryByText(/Produto sem fotos/)).toBeNull();
    expect(screen.queryByText(/no máximo 10 fotos/)).toBeNull();
  });

  it('stays silent while the photo count is still unknown', () => {
    // The produto snapshot reports `undefined` on its first render. Treating
    // that as 0 flashed "a publicação será bloqueada" on EVERY open — a false
    // alarm that trains operators to ignore the warning that matters.
    renderDetails({}, null);
    expect(screen.queryByText(/Produto sem fotos/)).toBeNull();
    expect(screen.queryByText(/foto\(s\)/)).toBeNull();
  });
});
