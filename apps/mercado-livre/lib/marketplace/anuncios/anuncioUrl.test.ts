import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

import {
  type AnuncioUrlApi,
  AnuncioUrlSemUserIdError,
  mlbProductUrl,
  resolveAnuncioUrl,
} from './anuncioUrl';

/** A real family id: ML's own numeric key, never `MLB`-prefixed. */
const FAMILIA = '6264141844942250';

/** The conta's own ML id — the família branch searches items under it. */
const SELLER = 4242;

function makeApi(overrides: Record<string, unknown> = {}): {
  api: AnuncioUrlApi;
  mocks: Record<string, ReturnType<typeof vi.fn>>;
} {
  const mocks = {
    getUserProductFamily: vi.fn(async () => ({ user_products_ids: ['MLBU1', 'MLBU2'] })),
    searchItemsByUserProduct: vi.fn(async () => ({ results: ['MLB555'] })),
    getItem: vi.fn(async (id: string) => ({ id, permalink: `https://ml/${id}` })),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>;
  return { api: mocks as unknown as AnuncioUrlApi, mocks };
}

/** The usual deps — a working conta id, which only the família branch reads. */
const deps = (api: AnuncioUrlApi): { api: AnuncioUrlApi; sellerUserId: number | null } => ({
  api,
  sellerUserId: SELLER,
});

const httpError = (status: number, message = `ML ${String(status)}`): MercadoLivreHttpError =>
  new MercadoLivreHttpError(message, status, null);

describe('resolveAnuncioUrl', () => {
  it('derives a legacy listing with NO ML call', async () => {
    // The browser already does this itself (`listingPermalink`); the route only
    // ever reaches here for a link that arrived mislabelled.
    const { api, mocks } = makeApi();

    expect(await resolveAnuncioUrl(deps(api), { id: 'MLB777', isUserProductModel: false })).toBe(
      'https://produto.mercadolivre.com.br/MLB-777',
    );
    expect(mocks.getUserProductFamily).not.toHaveBeenCalled();
    expect(mocks.getItem).not.toHaveBeenCalled();
  });

  it('resolves a User-Products family to an ACTIVE member item, never a /up/ page', async () => {
    // The bug this file exists to end: `user_products_ids` is unordered and
    // carries no status, so the old "first member" pick reached a UP page that
    // renders indisponível whenever that member has no live item.
    const { api, mocks } = makeApi();

    expect(await resolveAnuncioUrl(deps(api), { id: FAMILIA, isUserProductModel: true })).toBe(
      'https://ml/MLB555',
    );
    expect(mocks.searchItemsByUserProduct).toHaveBeenCalledWith(SELLER, ['MLBU1', 'MLBU2'], {
      limit: 1,
      offset: 0,
      status: 'active',
    });
    // A link, not a membership audit — one member is the whole answer.
    expect(mocks.searchItemsByUserProduct).toHaveBeenCalledTimes(1);
    expect(mocks.getItem).toHaveBeenCalledWith('MLB555');
  });

  it('retries the family search UNFILTERED when nothing comes back active', async () => {
    // Two cases share this path and both need it: a família whose members are all
    // paused (showing that paused item is honest), and an ML that declines to
    // combine `user_product_id` with `status` — which no lane here can exercise.
    const search = vi
      .fn()
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: ['MLB808'] });
    const { api, mocks } = makeApi({ searchItemsByUserProduct: search });

    expect(await resolveAnuncioUrl(deps(api), { id: FAMILIA, isUserProductModel: true })).toBe(
      'https://ml/MLB808',
    );
    expect(mocks.searchItemsByUserProduct).toHaveBeenCalledTimes(2);
    expect(mocks.searchItemsByUserProduct!.mock.calls[1]![2]).toEqual({ limit: 1, offset: 0 });
  });

  it('skips an empty member id rather than searching under it', async () => {
    const { api, mocks } = makeApi({
      getUserProductFamily: vi.fn(async () => ({ user_products_ids: ['', 'MLBU2'] })),
    });

    await resolveAnuncioUrl(deps(api), { id: FAMILIA, isUserProductModel: true });
    expect(mocks.searchItemsByUserProduct!.mock.calls[0]![1]).toEqual(['MLBU2']);
  });

  it('skips an empty item id in the search results', async () => {
    const { api } = makeApi({
      searchItemsByUserProduct: vi.fn(async () => ({ results: ['', 'MLB606'] })),
    });

    expect(await resolveAnuncioUrl(deps(api), { id: FAMILIA, isUserProductModel: true })).toBe(
      'https://ml/MLB606',
    );
  });

  it('refuses distinctly when the conta carries no ML user_id', async () => {
    // Not `null`: `null` is "gone from ML" and the route says so, while this is a
    // connection that never identified itself — opposite fixes.
    const { api, mocks } = makeApi();

    await expect(
      resolveAnuncioUrl({ api, sellerUserId: null }, { id: FAMILIA, isUserProductModel: true }),
    ).rejects.toBeInstanceOf(AnuncioUrlSemUserIdError);
    expect(mocks.getUserProductFamily).not.toHaveBeenCalled();
  });

  it('needs no user_id for a UP link that stores an item id', async () => {
    // Only the família branch searches; an item resolves on its own.
    const { api } = makeApi();

    expect(
      await resolveAnuncioUrl(
        { api, sellerUserId: null },
        { id: 'MLB999', isUserProductModel: true },
      ),
    ).toBe('https://ml/MLB999');
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
    });

    expect(
      await resolveAnuncioUrl(deps(api), { id: 'MLB4128712323', isUserProductModel: true }),
    ).toBe('https://ml/MLB4128712323');
    expect(mocks.getUserProductFamily).not.toHaveBeenCalled();
    expect(mocks.getItem).toHaveBeenCalledWith('MLB4128712323');
  });

  it('prefers the item PERMALINK over the User Product page', async () => {
    // The inverted assertion, and the whole point. A UP is a *product* — no price,
    // no shipping, no sale condition — so `/up/<MLBU>` has nothing to sell and
    // renders indisponível. ML's own `POST /items` example annotates the field:
    // "O permalink vai redirecionar para o UPP do item", so the permalink reaches
    // the same page WITH an offer selected.
    const { api } = makeApi({
      getItem: vi.fn(async () => ({
        id: 'MLB999',
        permalink: 'https://ml/MLB999',
        user_product_id: 'MLBU7',
      })),
    });

    const url = await resolveAnuncioUrl(deps(api), { id: 'MLB999', isUserProductModel: true });
    expect(url).toBe('https://ml/MLB999');
    expect(url).not.toContain('MLBU7');
  });

  it('falls back to the derived URL when ML sends no permalink', async () => {
    const { api } = makeApi({
      getItem: vi.fn(async () => ({ id: 'MLB999', permalink: null, user_product_id: 'MLBU7' })),
    });

    expect(await resolveAnuncioUrl(deps(api), { id: 'MLB999', isUserProductModel: true })).toBe(
      'https://produto.mercadolivre.com.br/MLB-999',
    );
  });

  it('treats an EMPTY permalink as no permalink', async () => {
    // `??` alone rejects only null/undefined, so `''` would be returned as the
    // answer and the route would reply 200 {"url": ""} — which a browser opens as
    // the current page, i.e. a link that silently does nothing.
    const { api } = makeApi({
      getItem: vi.fn(async () => ({ id: 'MLB999', permalink: '', user_product_id: '' })),
    });

    expect(await resolveAnuncioUrl(deps(api), { id: 'MLB999', isUserProductModel: true })).toBe(
      'https://produto.mercadolivre.com.br/MLB-999',
    );
  });

  it('answers null for a family ML no longer knows', async () => {
    const { api, mocks } = makeApi({
      getUserProductFamily: vi.fn(async () => {
        throw httpError(404);
      }),
    });

    expect(
      await resolveAnuncioUrl(deps(api), { id: FAMILIA, isUserProductModel: true }),
    ).toBeNull();
    // No doomed second call: an item id is never all digits, so `getItem(FAMILIA)`
    // could only ever fail.
    expect(mocks.searchItemsByUserProduct).not.toHaveBeenCalled();
    expect(mocks.getItem).not.toHaveBeenCalled();
  });

  it('answers null for a family that reports no members', async () => {
    const { api, mocks } = makeApi({
      getUserProductFamily: vi.fn(async () => ({ user_products_ids: [] })),
    });

    expect(
      await resolveAnuncioUrl(deps(api), { id: FAMILIA, isUserProductModel: true }),
    ).toBeNull();
    expect(mocks.searchItemsByUserProduct).not.toHaveBeenCalled();
    expect(mocks.getItem).not.toHaveBeenCalled();
  });

  it('answers null for a family whose members ML reports no items for', async () => {
    const { api, mocks } = makeApi({
      searchItemsByUserProduct: vi.fn(async () => ({ results: [] })),
    });

    expect(
      await resolveAnuncioUrl(deps(api), { id: FAMILIA, isUserProductModel: true }),
    ).toBeNull();
    // Both arms tried — filtered, then unfiltered — before giving up.
    expect(mocks.searchItemsByUserProduct).toHaveBeenCalledTimes(2);
    expect(mocks.getItem).not.toHaveBeenCalled();
  });

  it('answers null for an item that no longer exists', async () => {
    const { api } = makeApi({
      getItem: vi.fn(async () => {
        throw httpError(404);
      }),
    });

    expect(
      await resolveAnuncioUrl(deps(api), { id: 'MLB999', isUserProductModel: true }),
    ).toBeNull();
  });

  it('answers null when the family search 404s', async () => {
    const { api } = makeApi({
      searchItemsByUserProduct: vi.fn(async () => {
        throw httpError(404);
      }),
    });

    expect(
      await resolveAnuncioUrl(deps(api), { id: FAMILIA, isUserProductModel: true }),
    ).toBeNull();
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
      resolveAnuncioUrl(deps(api), { id: FAMILIA, isUserProductModel: true }),
    ).rejects.toThrow('indisponível');
  });

  it('propagates a search failure that is not a 404', async () => {
    const { api } = makeApi({
      searchItemsByUserProduct: vi.fn(async () => {
        throw httpError(500, 'busca fora do ar');
      }),
    });

    await expect(
      resolveAnuncioUrl(deps(api), { id: FAMILIA, isUserProductModel: true }),
    ).rejects.toThrow('busca fora do ar');
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
      resolveAnuncioUrl(deps(api), { id: FAMILIA, isUserProductModel: true }),
    ).rejects.toThrow('invalid value for id');
  });

  it('answers null for a listing that was never published', async () => {
    const { api, mocks } = makeApi();

    expect(await resolveAnuncioUrl(deps(api), { id: null, isUserProductModel: true })).toBeNull();
    expect(await resolveAnuncioUrl(deps(api), { id: '', isUserProductModel: false })).toBeNull();
    expect(mocks.getUserProductFamily).not.toHaveBeenCalled();
  });
});

describe('URL builders', () => {
  it('matches the browser-side copy in apps/web (listingLinks.ts)', () => {
    // Both surfaces must agree on where a given listing lives; the duplication
    // exists because the integrations root is server-only.
    expect(mlbProductUrl('MLB777')).toBe('https://produto.mercadolivre.com.br/MLB-777');
  });

  it('refuses to build a product URL from an id with no digits', () => {
    expect(mlbProductUrl('sem-digitos')).toBeNull();
  });
});

/**
 * The regression guard. Four separate places have now reached for the UP page —
 * this file twice, the browser helper, and the test that pinned it — so the
 * cheapest thing that ends it is an assertion that no CODE anywhere builds one.
 *
 * Comments are stripped first, deliberately: every ⚠️ that explains WHY the URL
 * is wrong has to be free to spell it out.
 */
describe('no surface builds a User Products page URL', () => {
  const ROOTS = ['apps/mercado-livre', 'apps/web'];
  const SKIP = new Set(['node_modules', '.next', 'dist', '.turbo', 'coverage', 'test-results']);

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        sourceFiles(full, out);
      } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  /** Block comments hold the JSDoc; a `//` line is stripped whole. */
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');

  it('never constructs mercadolivre.com.br/up/', () => {
    // Resolved from the repo root — vitest runs each workspace from its own cwd.
    const repoRoot = join(__dirname, '..', '..', '..', '..', '..');
    const scanned = ROOTS.flatMap((root) => sourceFiles(join(repoRoot, root)));

    // A guard that scans nothing rejects nothing. If a move breaks the path
    // above, fail HERE rather than pass vacuously for the rest of the repo's life.
    expect(scanned.length).toBeGreaterThan(200);

    const offenders = scanned.filter((file) =>
      stripComments(readFileSync(file, 'utf8')).includes('mercadolivre.com.br/up/'),
    );

    expect(offenders).toEqual([]);
  });
});
