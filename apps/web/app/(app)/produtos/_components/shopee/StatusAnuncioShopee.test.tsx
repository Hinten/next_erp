import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ProdutoShopeeLink } from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import { ROTULO_ALTERACOES_NAO_ENVIADAS_SHOPEE } from '@/lib/shopee/anuncioProduto';

import { StatusAnuncioShopee } from './StatusAnuncioShopee';

/** The «Alterações não enviadas» badge (PR3): an ERP-side edit saved and not yet sent. */

function mostrar(extra: Record<string, unknown>) {
  const link = {
    item_id: 987654321,
    estadoAnuncio: 'ativo',
    ...extra,
  } as unknown as ProdutoShopeeLink;
  render(
    <MantineTestProvider>
      <StatusAnuncioShopee link={link} shopId={123} />
    </MantineTestProvider>,
  );
}

describe('StatusAnuncioShopee — the pending-edit badge', () => {
  it('shows for a positive `edicaoErpPendenteEm`', () => {
    mostrar({ edicaoErpPendenteEm: 1_700_000_000_000 });
    expect(screen.getByText(ROTULO_ALTERACOES_NAO_ENVIADAS_SHOPEE)).toBeTruthy();
  });

  it.each([
    ['absent', {}],
    ['zero', { edicaoErpPendenteEm: 0 }],
    ['null', { edicaoErpPendenteEm: null }],
  ])('NEAR-MISS: %s ⇒ no badge', (_nome, extra) => {
    mostrar(extra);
    expect(screen.queryByText(ROTULO_ALTERACOES_NAO_ENVIADAS_SHOPEE)).toBeNull();
  });
});
