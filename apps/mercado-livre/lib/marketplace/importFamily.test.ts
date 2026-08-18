import { describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { MAX_FAMILY_SIBLINGS, resolveFamilySiblingIds } from './importFamily';

/**
 * The IMPORT half of the family fan-out. It wants "enough", not everything —
 * `capped` is how it says the rest can wait — which is the opposite of what the
 * publish orphan sweep needs from `resolveFamilyItemIds` (complete or an error;
 * those cases live in `publishUserProduct.test.ts`, beside the consumer whose
 * safety depends on them).
 */

function makeApi(overrides: Record<string, unknown> = {}): {
  api: MercadoLivreApi;
  mocks: Record<string, ReturnType<typeof vi.fn>>;
} {
  const mocks = {
    getUserProductFamily: vi.fn(async () => ({ user_products_ids: ['MLBU1', 'MLBU2'] })),
    searchItemsByUserProduct: vi.fn(async () => ({ results: ['MLB1', 'MLB2', 'MLB3'] })),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>;
  return { api: mocks as unknown as MercadoLivreApi, mocks };
}

describe('resolveFamilySiblingIds', () => {
  it('drops the primary and returns the rest', async () => {
    const { api } = makeApi();

    expect(await resolveFamilySiblingIds({ api }, 'FAM-1', 9, 'MLB2')).toEqual({
      ids: ['MLB1', 'MLB3'],
      capped: false,
      resolutionError: null,
    });
  });

  it('asks for ONE MORE than the cap, which is what makes `capped` reachable', async () => {
    // ⚠️ The read used to send no `limit` at all, so ML applied its own default
    // page size: a family bigger than that came back short and `capped` could
    // never go true against a real response — only against a mock returning more
    // than one page's worth. Asking for cap+1 is what detects the overflow.
    const { api, mocks } = makeApi();

    await resolveFamilySiblingIds({ api }, 'FAM-1', 9, 'MLB2');

    expect(mocks.searchItemsByUserProduct!.mock.calls[0]![2]).toEqual({
      limit: MAX_FAMILY_SIBLINGS + 1,
      offset: 0,
    });
  });

  it('caps and says so when the family overflows', async () => {
    const many = Array.from({ length: MAX_FAMILY_SIBLINGS + 5 }, (_, i) => `MLB${i}`);
    const { api } = makeApi({ searchItemsByUserProduct: vi.fn(async () => ({ results: many })) });

    const out = await resolveFamilySiblingIds({ api }, 'FAM-1', 9, 'nao-presente');

    expect(out.capped).toBe(true);
    expect(out.ids).toHaveLength(MAX_FAMILY_SIBLINGS);
    expect(out.resolutionError).toBeNull();
  });

  it('reads ONE page — a truncated answer is fine here, unlike the sweep', async () => {
    const { api, mocks } = makeApi({
      searchItemsByUserProduct: vi.fn(async () => ({
        results: Array.from({ length: MAX_FAMILY_SIBLINGS + 1 }, (_, i) => `MLB${i}`),
        paging: { total: 10_000 },
      })),
    });

    const out = await resolveFamilySiblingIds({ api }, 'FAM-1', 9, 'nao-presente');

    // ML says there are thousands; import neither pages for them nor treats the
    // shortfall as a failure. It caps and moves on.
    expect(mocks.searchItemsByUserProduct).toHaveBeenCalledTimes(1);
    expect(out.capped).toBe(true);
    expect(out.resolutionError).toBeNull();
  });

  it('an empty family needs no second call', async () => {
    const { api, mocks } = makeApi({
      getUserProductFamily: vi.fn(async () => ({ user_products_ids: [] })),
    });

    expect(await resolveFamilySiblingIds({ api }, 'FAM-1', 9, 'MLB1')).toEqual({
      ids: [],
      capped: false,
      resolutionError: null,
    });
    expect(mocks.searchItemsByUserProduct).not.toHaveBeenCalled();
  });

  it('surfaces an ML failure instead of passing it off as an empty family', async () => {
    // The caller falls back to a primary-only import either way, but it reports
    // the two differently — "no siblings" is not "we could not ask".
    const { api } = makeApi({
      getUserProductFamily: vi.fn(async () => {
        throw new MercadoLivreHttpError('indisponível', 503, null);
      }),
    });

    const out = await resolveFamilySiblingIds({ api }, 'FAM-1', 9, 'MLB1');

    expect(out.ids).toEqual([]);
    expect(out.resolutionError).toBe('indisponível');
  });

  it('rethrows anything that is not an ML error', async () => {
    const { api } = makeApi({
      searchItemsByUserProduct: vi.fn(async () => {
        throw new TypeError('bug');
      }),
    });

    await expect(resolveFamilySiblingIds({ api }, 'FAM-1', 9, 'MLB1')).rejects.toThrow(TypeError);
  });
});
