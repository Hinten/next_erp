import { describe, expect, it } from 'vitest';

import {
  estadoLabel,
  isStockLatched,
  listingModel,
  listingPermalink,
  parseEstado,
  refMatchesIntegracao,
} from './listingLinks';

describe('refMatchesIntegracao', () => {
  it('accepts both the stored documents/ form and the bare one', () => {
    expect(refMatchesIntegracao('documents/integracao/conta-1', 'conta-1')).toBe(true);
    expect(refMatchesIntegracao('integracao/conta-1', 'conta-1')).toBe(true);
  });

  it('rejects another account and an absent ref', () => {
    expect(refMatchesIntegracao('documents/integracao/conta-2', 'conta-1')).toBe(false);
    expect(refMatchesIntegracao(null, 'conta-1')).toBe(false);
    expect(refMatchesIntegracao('', 'conta-1')).toBe(false);
  });

  it('does not match on a suffix that is not a path segment', () => {
    expect(refMatchesIntegracao('documents/integracao/outra-conta-1', 'conta-1')).toBe(false);
  });
});

describe('parseEstado / estadoLabel', () => {
  it('labels a known estado code', () => {
    expect(parseEstado('p')).toBe('p');
    expect(estadoLabel('p')).toBe('Publicado');
    expect(estadoLabel('E')).toBe('Erro');
  });

  it('soft-parses an unknown code instead of throwing', () => {
    // The Flutter app can hold values this schema has never seen.
    expect(parseEstado('zz')).toBeNull();
    expect(estadoLabel('zz')).toBe('zz');
    expect(estadoLabel(null)).toBe('Desconhecido');
  });
});

describe('listingModel', () => {
  it('distinguishes the two coexisting models', () => {
    expect(listingModel({ isUserProductModel: true })).toBe('user-products');
    expect(listingModel({ isUserProductModel: false })).toBe('legacy');
    expect(listingModel({})).toBe('legacy');
  });
});

describe('isStockLatched', () => {
  it('is latched only for a PUBLISHED listing in error', () => {
    expect(isStockLatched({ estado: 'E', id: 'MLB1' })).toBe(true);
    expect(isStockLatched({ estado: 'E', id: null })).toBe(false); // never published
    expect(isStockLatched({ estado: 'p', id: 'MLB1' })).toBe(false);
  });
});

describe('listingPermalink', () => {
  it('builds the legacy URL from the stored id with no round trip', () => {
    expect(listingPermalink({ id: 'MLB777', isUserProductModel: false })).toBe(
      'https://produto.mercadolivre.com.br/MLB-777',
    );
  });

  it('prefers the user_product_id for a User-Products listing', () => {
    expect(
      listingPermalink(
        { id: '6264141844942250', isUserProductModel: true },
        { userProductId: 'MLBU3844434863' },
      ),
    ).toBe('https://www.mercadolivre.com.br/up/MLBU3844434863');
  });

  it('falls back to a member item, which resolves and redirects', () => {
    expect(
      listingPermalink(
        { id: '6264141844942250', isUserProductModel: true },
        { firstMemberItemId: 'MLB999' },
      ),
    ).toBe('https://produto.mercadolivre.com.br/MLB-999');
  });

  it('returns null when there is nothing to link to yet', () => {
    expect(listingPermalink({ id: null, isUserProductModel: false })).toBeNull();
    expect(listingPermalink({ id: 'MLB1', isUserProductModel: true })).toBeNull();
    // A UP family id is NOT an MLB item id — never build a product URL from it.
    expect(listingPermalink({ id: 'sem-digitos', isUserProductModel: false })).toBeNull();
  });
});
