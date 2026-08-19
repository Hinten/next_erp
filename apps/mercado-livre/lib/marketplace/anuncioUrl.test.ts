import { describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

import { type AnuncioUrlApi, mlbProductUrl, resolveAnuncioUrl, upProductUrl } from './anuncioUrl';

/** A real family id: ML's own numeric key, never `MLB`-prefixed. */
const FAMILIA = '6264141844942250';

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

const httpError = (status: number, message = `ML ${String(status)}`): MercadoLivreHttpError =>
  new MercadoLivreHttpError(message, status, null);

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

    expect(await resolveAnuncioUrl({ api }, { id: FAMILIA, isUserProductModel: true })).toBe(
      'https://www.mercadolivre.com.br/up/MLBU1',
    );
    // ONE request — the old Flutter screen spent two to reach the same URL.
    expect(mocks.getUserProductFamily).toHaveBeenCalledTimes(1);
    expect(mocks.getItem).not.toHaveBeenCalled();
  });

  it('skips an empty member id rather than building /up/', async () => {
    const { api } = makeApi({
      getUserProductFamily: vi.fn(async () => ({ user_products_ids: ['', 'MLBU2'] })),
    });

    expect(await resolveAnuncioUrl({ api }, { id: FAMILIA, isUserProductModel: true })).toBe(
      'https://www.mercadolivre.com.br/up/MLBU2',
    );
  });

  it('reads the ITEM when a UP link stores an item id, never the families endpoint', async () => {
    // The reported 400. `link.id` is `familyId ?? itemId`, and the UPtin takeover
    // (`importMigration.ts`) sets isUserProductModel on an existing link WITHOUT
    // touching its id — so a migrated listing keeps its `MLB…`. Sending that to
    // /user-products-families answers 400 `invalid value for id`, which is not a
    // 404 and so used to reach the operator verbatim.
    const { api, mocks } = makeApi({
      getUserProductFamily: vi.fn(async () => {
        throw httpError(400, 'invalid value for id');
      }),
      getItem: vi.fn(async () => ({
        id: 'MLB4128712323',
        permalink: 'https://ml/MLB4128712323',
        user_product_id: 'MLBU3844434863',
      })),
    });

    expect(
      await resolveAnuncioUrl({ api }, { id: 'MLB4128712323', isUserProductModel: true }),
    ).toBe('https://www.mercadolivre.com.br/up/MLBU3844434863');
    expect(mocks.getUserProductFamily).not.toHaveBeenCalled();
    expect(mocks.getItem).toHaveBeenCalledWith('MLB4128712323');
  });

  it('prefers the item user_product_id over its permalink', async () => {
    // The UP page groups every sale condition of the product — the page the
    // family branch reaches and the old Flutter screen opened. `permalink` names
    // one condition, so it is the fallback, not the answer.
    const { api } = makeApi({
      getItem: vi.fn(async () => ({
        id: 'MLB999',
        permalink: 'https://ml/MLB999',
        user_product_id: 'MLBU7',
      })),
    });

    expect(await resolveAnuncioUrl({ api }, { id: 'MLB999', isUserProductModel: true })).toBe(
      'https://www.mercadolivre.com.br/up/MLBU7',
    );
  });

  it('falls back to the permalink for an item ML reports with no UP id', async () => {
    const { api } = makeApi();

    expect(await resolveAnuncioUrl({ api }, { id: 'MLB999', isUserProductModel: true })).toBe(
      'https://ml/MLB999',
    );
  });

  it('falls back to the derived URL when ML sends no permalink either', async () => {
    const { api } = makeApi({
      getItem: vi.fn(async () => ({ id: 'MLB999', permalink: null })),
    });

    expect(await resolveAnuncioUrl({ api }, { id: 'MLB999', isUserProductModel: true })).toBe(
      'https://produto.mercadolivre.com.br/MLB-999',
    );
  });

  it('answers null for a family ML no longer knows', async () => {
    const { api, mocks } = makeApi({
      getUserProductFamily: vi.fn(async () => {
        throw httpError(404);
      }),
    });

    expect(await resolveAnuncioUrl({ api }, { id: FAMILIA, isUserProductModel: true })).toBeNull();
    // No doomed second call: an item id is never all digits, so `getItem(FAMILIA)`
    // could only ever fail.
    expect(mocks.getItem).not.toHaveBeenCalled();
  });

  it('answers null for a family that reports no members', async () => {
    const { api, mocks } = makeApi({
      getUserProductFamily: vi.fn(async () => ({ user_products_ids: [] })),
    });

    expect(await resolveAnuncioUrl({ api }, { id: FAMILIA, isUserProductModel: true })).toBeNull();
    expect(mocks.getItem).not.toHaveBeenCalled();
  });

  it('answers null for an item that no longer exists', async () => {
    const { api } = makeApi({
      getItem: vi.fn(async () => {
        throw httpError(404);
      }),
    });

    expect(await resolveAnuncioUrl({ api }, { id: 'MLB999', isUserProductModel: true })).toBeNull();
  });

  it('propagates a failure that is not a 404', async () => {
    // A 5xx or a dead token is a failure to ANSWER — reporting it beats handing
    // the operator a URL built from a shape we never confirmed.
    const { api } = makeApi({
      getUserProductFamily: vi.fn(async () => {
        throw httpError(502, 'indisponível');
      }),
    });

    await expect(
      resolveAnuncioUrl({ api }, { id: FAMILIA, isUserProductModel: true }),
    ).rejects.toThrow('indisponível');
  });

  it('still propagates a 400 raised for a genuinely family-shaped id', async () => {
    // The dispatch is on the id SHAPE, not on ML's error taxonomy — so a 400 here
    // is unexplained and must surface. Swallowing it would hide the next bug of
    // this class instead of ending it.
    const { api } = makeApi({
      getUserProductFamily: vi.fn(async () => {
        throw httpError(400, 'invalid value for id');
      }),
    });

    await expect(
      resolveAnuncioUrl({ api }, { id: FAMILIA, isUserProductModel: true }),
    ).rejects.toThrow('invalid value for id');
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
