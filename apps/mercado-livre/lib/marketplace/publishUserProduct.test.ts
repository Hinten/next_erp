import { describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { sweepRemovedMembers } from './publishUserProduct';
import { FAMILY_ITEMS_PAGE_SIZE, resolveFamilyItemIds } from './importFamily';

/**
 * The removed-variation sweep decides what to CLOSE on a live marketplace, and
 * closing an ML item is effectively terminal — it stops selling, loses its
 * permalink and position, and cannot be reopened as the same listing. So the
 * interesting cases here are all the ways it must REFUSE: every one of them is a
 * situation where the set difference looks like "these variations were deleted"
 * and is actually "we cannot see the family properly".
 */

function makeApi(overrides: Record<string, unknown> = {}): {
  api: MercadoLivreApi;
  mocks: Record<string, ReturnType<typeof vi.fn>>;
} {
  const mocks = {
    getUserProductFamily: vi.fn(async () => ({ user_products_ids: ['MLBU1', 'MLBU2', 'MLBU3'] })),
    searchItemsByUserProduct: vi.fn(async () => ({
      results: ['MLB1', 'MLB2', 'MLB3'],
      paging: { total: 3, limit: FAMILY_ITEMS_PAGE_SIZE, offset: 0 },
    })),
    updateItem: vi.fn(async (id: string) => ({ id, status: 'closed' })),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>;
  return { api: mocks as unknown as MercadoLivreApi, mocks };
}

/** `n` synthetic item ids, for the paging cases. */
const idsOf = (from: number, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `MLB${from + i}`);

const ARGS = { familyId: 'FAM-1', sellerUserId: 9 };

describe('sweepRemovedMembers', () => {
  it('pauses THEN closes exactly the items no longer backed by a variação', async () => {
    const { api, mocks } = makeApi();

    const out = await sweepRemovedMembers({ api }, { ...ARGS, keptItemIds: ['MLB1', 'MLB2'] });

    expect(out).toEqual({ closed: ['MLB3'], skipped: null });
    // Pause first (legacy order): ML rejects closing some listing states
    // directly, and pausing alone already stops the sale — so the pair degrades
    // safely if the second call fails.
    expect(mocks.updateItem!.mock.calls).toEqual([
      ['MLB3', { status: 'paused' }],
      ['MLB3', { status: 'closed' }],
    ]);
  });

  it('closes nothing when the family is exactly what we published', async () => {
    const { api, mocks } = makeApi();

    const out = await sweepRemovedMembers(
      { api },
      { ...ARGS, keptItemIds: ['MLB1', 'MLB2', 'MLB3'] },
    );

    expect(out).toEqual({ closed: [], skipped: null });
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('refuses when the family READ failed — an error is not an empty family', async () => {
    // Treating the two alike would read "ML returned no members" out of a 500
    // and close the entire family.
    const { api, mocks } = makeApi({
      getUserProductFamily: vi.fn(async () => {
        throw new MercadoLivreHttpError('indisponível', 503, null);
      }),
    });

    const out = await sweepRemovedMembers({ api }, { ...ARGS, keptItemIds: ['MLB1'] });

    expect(out.closed).toEqual([]);
    expect(out.skipped).toMatch(/não foi possível ler a família/);
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('refuses when a member we JUST published is missing from the membership', async () => {
    // ML indexes a fresh create asynchronously, so right after a first publish
    // the family search can lag behind. Our view disagreeing with ML's is
    // exactly when the set difference is worthless.
    const { api, mocks } = makeApi({
      searchItemsByUserProduct: vi.fn(async () => ({ results: ['MLB1', 'MLB3'] })),
    });

    const out = await sweepRemovedMembers({ api }, { ...ARGS, keptItemIds: ['MLB1', 'MLB2'] });

    expect(out.closed).toEqual([]);
    expect(out.skipped).toMatch(/ainda não reflete/);
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('refuses to close the WHOLE family', async () => {
    // Never a legitimate outcome of "some variations were removed" — and the
    // produto is still published, so it would leave the ERP pointing at nothing.
    const { api, mocks } = makeApi({
      searchItemsByUserProduct: vi.fn(async () => ({ results: ['MLB7', 'MLB8'] })),
    });

    const out = await sweepRemovedMembers({ api }, { ...ARGS, keptItemIds: [] });

    expect(out.closed).toEqual([]);
    expect(out.skipped).toMatch(/nenhum anúncio publicado agora/);
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('refuses without a familyId or a seller id — it cannot enumerate anything', async () => {
    const { api, mocks } = makeApi();

    expect(
      await sweepRemovedMembers({ api }, { ...ARGS, familyId: null, keptItemIds: ['MLB1'] }),
    ).toEqual({ closed: [], skipped: 'família sem id' });
    expect(
      await sweepRemovedMembers({ api }, { ...ARGS, sellerUserId: null, keptItemIds: ['MLB1'] }),
    ).toEqual({ closed: [], skipped: 'integração sem user_id' });
    expect(mocks.getUserProductFamily).not.toHaveBeenCalled();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('one orphan failing to close does not stop the others', async () => {
    const { api } = makeApi({
      searchItemsByUserProduct: vi.fn(async () => ({ results: ['MLB1', 'MLB2', 'MLB3'] })),
      updateItem: vi.fn(async (id: string) => {
        if (id === 'MLB2') throw new MercadoLivreHttpError('not_closable', 400, null);
        return { id, status: 'closed' };
      }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await sweepRemovedMembers({ api }, { ...ARGS, keptItemIds: ['MLB1'] });

    expect(out).toEqual({ closed: ['MLB3'], skipped: null });
  });

  it('rethrows anything that is not an ML error', async () => {
    // A coding bug must not be swallowed by the best-effort wrapper.
    const { api } = makeApi({
      updateItem: vi.fn(async () => {
        throw new TypeError('bug');
      }),
    });

    await expect(
      sweepRemovedMembers({ api }, { ...ARGS, keptItemIds: ['MLB1', 'MLB2'] }),
    ).rejects.toThrow(TypeError);
  });
});

/**
 * The membership read behind the sweep. Its whole job is to be COMPLETE or say
 * it isn't: `GET /users/{id}/items/search` answers with ML's first page by
 * default, and the sweep decides what to CLOSE from the result — so a silent
 * prefix would either close live listings or (via the sweep's own guard) make
 * the feature permanently, invisibly inert for the big families it exists for.
 */
describe('resolveFamilyItemIds — completeness', () => {
  it('sends an explicit limit/offset and returns a short first page as complete', async () => {
    const { api, mocks } = makeApi();

    expect(await resolveFamilyItemIds({ api }, 'FAM-1', 9)).toEqual({
      ids: ['MLB1', 'MLB2', 'MLB3'],
      resolutionError: null,
    });
    expect(mocks.searchItemsByUserProduct).toHaveBeenCalledTimes(1);
    expect(mocks.searchItemsByUserProduct!.mock.calls[0]![2]).toEqual({
      limit: FAMILY_ITEMS_PAGE_SIZE,
      offset: 0,
    });
  });

  it('walks every page of a family larger than one page', async () => {
    const page1 = idsOf(1000, FAMILY_ITEMS_PAGE_SIZE);
    const page2 = idsOf(2000, 4);
    const search = vi.fn(async (_s: number, _u: readonly string[], page?: { offset?: number }) =>
      (page?.offset ?? 0) === 0
        ? { results: page1, paging: { total: page1.length + page2.length, offset: 0 } }
        : { results: page2, paging: { total: page1.length + page2.length, offset: 50 } },
    );
    const { api } = makeApi({ searchItemsByUserProduct: search });

    const out = await resolveFamilyItemIds({ api }, 'FAM-1', 9);

    expect(out.resolutionError).toBeNull();
    expect(out.ids).toHaveLength(page1.length + page2.length);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('reports truncation rather than returning a prefix', async () => {
    // ML says there are more than it gave us AND the page was short — a state we
    // cannot reconcile, so it is a "we couldn't ask" fact, not a membership.
    const { api } = makeApi({
      searchItemsByUserProduct: vi.fn(async () => ({
        results: ['MLB1'],
        paging: { total: 9 },
      })),
    });

    const out = await resolveFamilyItemIds({ api }, 'FAM-1', 9);

    expect(out.ids).toEqual([]);
    expect(out.resolutionError).toMatch(/1 de 9/);
  });

  it('gives up loudly past the page cap instead of walking forever', async () => {
    const { api } = makeApi({
      // Always a full page and always more to come.
      searchItemsByUserProduct: vi.fn(
        async (_s: number, _u: readonly string[], page?: { offset?: number }) => ({
          results: idsOf((page?.offset ?? 0) * 100, FAMILY_ITEMS_PAGE_SIZE),
          paging: { total: 100_000 },
        }),
      ),
    });

    const out = await resolveFamilyItemIds({ api }, 'FAM-1', 9);

    expect(out.ids).toEqual([]);
    expect(out.resolutionError).toMatch(/mais de \d+ anúncios/);
  });

  it('degrades to the short-page test when ML sends no paging block', async () => {
    // `paging` is optional on the schema; its absence must never be read as a
    // claim of completeness, only fall back to the weaker signal.
    const { api } = makeApi({
      searchItemsByUserProduct: vi.fn(async () => ({ results: ['MLB1', 'MLB2'] })),
    });

    expect(await resolveFamilyItemIds({ api }, 'FAM-1', 9)).toEqual({
      ids: ['MLB1', 'MLB2'],
      resolutionError: null,
    });
  });

  it('a truncated read makes the SWEEP refuse, closing nothing', async () => {
    // The two halves joined up: this is the state that used to be invisible.
    const { api, mocks } = makeApi({
      searchItemsByUserProduct: vi.fn(async () => ({ results: ['MLB1'], paging: { total: 9 } })),
    });

    const out = await sweepRemovedMembers(
      { api },
      { familyId: 'FAM-1', sellerUserId: 9, keptItemIds: ['MLB1'] },
    );

    expect(out.closed).toEqual([]);
    expect(out.skipped).toMatch(/não foi possível ler a família/);
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });
});
