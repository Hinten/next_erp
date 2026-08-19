import { describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

import { type AnuncioUrlApi, mlbProductUrl, resolveAnuncioUrl, upProductUrl } from './anuncioUrl';

function makeApi(overrides: Record<string, unknown> = {}): {
  api: AnuncioUrlApi;
  mocks: Record<string, ReturnType<typeof vi.fn>>;
} {
  const mocks = {
    getUserProductFamily: vi.fn(async () => ({ user_products_ids: ['MLBU1', 'MLBU2'] })),
    getItem: vi.fn(async () => ({ id: 'MLB999', permalink: 'https://ml/MLB999' })),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>;
  return { api: mocks as unknown as AnuncioUrlApi, mocks };
}

const notFound = (): MercadoLivreHttpError =>
  new MercadoLivreHttpError('nao encontrado', 404, null);

describe('resolveAnuncioUrl', () => {
  it('derives a legacy listing with NO ML call', async () => {
    // The browser already does this itself (`listingPermalink`); the route only
    // ever reaches here for a link that arrived mislabelled.
    const { api, mocks } = makeApi();

    expect(await resolveAnuncioUrl({ api }, { id: 'MLB777', isUserProductModel: false })).toBe(
      'https://produto.mercadolivre.com.br/MLB-777',
    );
    expect(mocks.getUserProductFamily).not.toHaveBeenCalled();
    expect(mocks.getItem).not.toHaveBeenCalled();
  });

  it('resolves a User-Products family to its first member page', async () => {
    const { api, mocks } = makeApi();

    expect(
      await resolveAnuncioUrl({ api }, { id: '6264141844942250', isUserProductModel: true }),
    ).toBe('https://www.mercadolivre.com.br/up/MLBU1');
    // ONE request — the old Flutter screen spent two to reach the same URL.
    expect(mocks.getUserProductFamily).toHaveBeenCalledTimes(1);
    expect(mocks.getItem).not.toHaveBeenCalled();
  });

  it('skips an empty member id rather than building /up/', async () => {
    const { api } = makeApi({
      getUserProductFamily: vi.fn(async () => ({ user_products_ids: ['', 'MLBU2'] })),
    });

    expect(await resolveAnuncioUrl({ api }, { id: 'FAM-1', isUserProductModel: true })).toBe(
      'https://www.mercadolivre.com.br/up/MLBU2',
    );
  });

  it("reads the item when the 'family' is really an item id", async () => {
    // A Flutter-written link can carry an ITEM id under isUserProductModel:true —
    // the flag flips on the UPtin takeover and older rows were never rewritten.
    const { api, mocks } = makeApi({
      getUserProductFamily: vi.fn(async () => {
        throw notFound();
      }),
    });

    expect(await resolveAnuncioUrl({ api }, { id: 'MLB999', isUserProductModel: true })).toBe(
      'https://ml/MLB999',
    );
    expect(mocks.getItem).toHaveBeenCalledWith('MLB999');
  });

  it('reads the item when the family reports no members', async () => {
    const { api, mocks } = makeApi({
      getUserProductFamily: vi.fn(async () => ({ user_products_ids: [] })),
    });

    expect(await resolveAnuncioUrl({ api }, { id: 'MLB999', isUserProductModel: true })).toBe(
      'https://ml/MLB999',
    );
    expect(mocks.getItem).toHaveBeenCalledTimes(1);
  });

  it('falls back to the derived URL when ML sends no permalink', async () => {
    const { api } = makeApi({
      getUserProductFamily: vi.fn(async () => ({ user_products_ids: [] })),
      getItem: vi.fn(async () => ({ id: 'MLB999', permalink: null })),
    });

    expect(await resolveAnuncioUrl({ api }, { id: 'MLB999', isUserProductModel: true })).toBe(
      'https://produto.mercadolivre.com.br/MLB-999',
    );
  });

  it('answers null for a listing that no longer exists', async () => {
    const { api } = makeApi({
      getUserProductFamily: vi.fn(async () => {
        throw notFound();
      }),
      getItem: vi.fn(async () => {
        throw notFound();
      }),
    });

    expect(await resolveAnuncioUrl({ api }, { id: 'MLB999', isUserProductModel: true })).toBeNull();
  });

  it('propagates a failure that is not a 404', async () => {
    // A 5xx or a dead token is a failure to ANSWER — reporting it beats handing
    // the operator a URL built from a shape we never confirmed.
    const { api } = makeApi({
      getUserProductFamily: vi.fn(async () => {
        throw new MercadoLivreHttpError('indisponível', 502, null);
      }),
    });

    await expect(
      resolveAnuncioUrl({ api }, { id: 'FAM-1', isUserProductModel: true }),
    ).rejects.toThrow('indisponível');
  });

  it('answers null for a listing that was never published', async () => {
    const { api, mocks } = makeApi();

    expect(await resolveAnuncioUrl({ api }, { id: null, isUserProductModel: true })).toBeNull();
    expect(await resolveAnuncioUrl({ api }, { id: '', isUserProductModel: false })).toBeNull();
    expect(mocks.getUserProductFamily).not.toHaveBeenCalled();
  });
});

describe('URL builders', () => {
  it('matches the browser-side copy in apps/web (listingLinks.ts)', () => {
    // Both surfaces must agree on where a given listing lives; the duplication
    // exists because the integrations root is server-only.
    expect(mlbProductUrl('MLB777')).toBe('https://produto.mercadolivre.com.br/MLB-777');
    expect(upProductUrl('MLBU3844434863')).toBe(
      'https://www.mercadolivre.com.br/up/MLBU3844434863',
    );
  });

  it('refuses to build a product URL from an id with no digits', () => {
    expect(mlbProductUrl('sem-digitos')).toBeNull();
  });
});
