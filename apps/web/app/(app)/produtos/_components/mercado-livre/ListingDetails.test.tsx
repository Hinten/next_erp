import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';

import { linkFixture } from '@/lib/mercado-livre/linkFixture';
import { ListingDetails } from './ListingDetails';

function renderDetails(over: Partial<ProdutoMercadoLivreLink> = {}, fotos: number | null = 3) {
  render(
    <MantineProvider env="test">
      <ListingDetails link={linkFixture(over)} produtoFotoCount={fotos} />
    </MantineProvider>,
  );
}

describe('ListingDetails', () => {
  it('shows the server-owned fields the screen never surfaced', () => {
    renderDetails({ precoPublicado: 79.9, comissao: 12.34 });
    expect(screen.getByText('R$ 79,90')).toBeDefined();
    expect(screen.getByText('R$ 12,34')).toBeDefined();
  });

  it('leaves the category to the form, so there is only one of it on screen', () => {
    // `category_id` is operator-owned and now editable through the cascade
    // picker in ListingForm. Echoing it here would show the same value twice,
    // one of them stale the moment the picker is used.
    renderDetails();
    expect(screen.queryByText('Categoria')).toBeNull();
    expect(screen.queryByText('MLB31447')).toBeNull();
  });

  it('renders nothing the operator owns as a labelled control', () => {
    // A labelled control appearing here would both duplicate the input and
    // resurrect the e2e locator that proves the first-publish "Tipo de anúncio"
    // Select is gone once published.
    renderDetails();
    expect(screen.queryByLabelText('Tipo de anúncio')).toBeNull();
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
