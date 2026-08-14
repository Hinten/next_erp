import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  listSiteCategories: vi.fn(),
  getCategory: vi.fn(),
  getCategoryListingTypes: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return {
    ...actual,
    createMercadoLivreApi: () => ({
      listSiteCategories: h.listSiteCategories,
      getCategory: h.getCategory,
      getCategoryListingTypes: h.getCategoryListingTypes,
      getMe: h.getMe,
    }),
  };
});

const { GET } = await import('./route');

const req = (qs = '?integracaoId=int-1') =>
  new Request(`http://localhost:3006/api/marketplace/mercado-livre/anuncio-teste${qs}`);

interface Body {
  title: string;
  descricao: string;
  categoryId: string | null;
  categoriaPath: string[] | null;
  listingTypeId: string | null;
  conta: { nickname: string | null; ehContaDeTeste: boolean };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllReadCaches();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.resolveChannelContext.mockResolvedValue({ integracaoId: 'i', accessToken: 'AT', account: {} });
  h.loadCtx.mockResolvedValue({ resolveChannelContext: h.resolveChannelContext });
  h.listSiteCategories.mockResolvedValue([
    { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
    { id: 'MLB5672', name: 'Outros' },
  ]);
  // A leaf by default — `children_categories` empty.
  h.getCategory.mockResolvedValue({ id: 'MLB5672', name: 'Outros', children_categories: [] });
  h.getCategoryListingTypes.mockResolvedValue([{ id: 'gold_pro' }, { id: 'free' }]);
  h.getMe.mockResolvedValue({ id: 1, nickname: 'TETE8127263' });
});

describe('GET /api/marketplace/mercado-livre/anuncio-teste', () => {
  it('rejects an unauthorized caller', async () => {
    h.verifyCaller.mockResolvedValue({ error: new Response(null, { status: 403 }) });
    expect((await GET(req())).status).toBe(403);
  });

  it('400s without integracaoId', async () => {
    expect((await GET(req('?'))).status).toBe(400);
  });

  it('returns ML’s documented title and a resolved leaf category', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.title).toBe('Item de Teste – Por favor, NÃO OFERTAR!');
    expect(body.categoryId).toBe('MLB5672');
    // `free` is the lowest exposure on offer; `gold_pro` is Premium and banned.
    expect(body.listingTypeId).toBe('free');
  });

  it('resolves the category by NAME, never a hardcoded id', async () => {
    // A hardcoded "Outros" id would file a test listing into a real category —
    // MLB's id is not verifiable offline and public sources contradict each other.
    h.listSiteCategories.mockResolvedValue([{ id: 'MLB9999', name: 'outros' }]);
    h.getCategory.mockResolvedValue({ id: 'MLB9999', children_categories: [] });
    const body = (await (await GET(req())).json()) as Body;
    expect(body.categoryId).toBe('MLB9999');
  });

  it('reports NO category when ML has no "Outros" root', async () => {
    h.listSiteCategories.mockResolvedValue([{ id: 'MLB1430', name: 'Calçados' }]);
    const body = (await (await GET(req())).json()) as Body;
    expect(body.categoryId).toBeNull();
    expect(body.listingTypeId).toBeNull();
  });

  // ⚠️ **The defect that made the whole feature look broken.** ML's "Outros" is a
  // root WITH children, and only a leaf can be published into — so demanding the
  // root itself be a leaf meant `categoryId` came back null on EVERY call, the
  // form's null-guard skipped the write, and the operator watched the título
  // change while the category and the whole attribute grid sat still.
  it('descends into a non-leaf "Outros" and resolves the leaf beneath it', async () => {
    h.getCategory.mockImplementation(async (id: string) =>
      id === 'MLB5672'
        ? {
            id,
            name: 'Outros',
            children_categories: [
              { id: 'MLB1000', name: 'Antiguidades' },
              { id: 'MLB5673', name: 'Outros' },
            ],
          }
        : { id, name: 'Outros', children_categories: [] },
    );
    const body = (await (await GET(req())).json()) as Body;
    // The homonym wins over the first child.
    expect(body.categoryId).toBe('MLB5673');
    expect(body.categoriaPath).toEqual(['Outros', 'Outros']);
    // And the listing type is queried for the LEAF, never the mid-tree node.
    expect(h.getCategoryListingTypes).toHaveBeenCalledWith('MLB5673');
    expect(body.listingTypeId).toBe('free');
  });

  it('gives up rather than crawling a pathological tree', async () => {
    // Every level costs one `GET /categories/{id}`, so the depth cap is the only
    // thing bounding the call count.
    h.getCategory.mockImplementation(async (id: string) => ({
      id,
      name: 'Outros',
      children_categories: [{ id: `${id}-x`, name: 'Outros' }],
    }));
    const body = (await (await GET(req())).json()) as Body;
    expect(body.categoryId).toBeNull();
    expect(body.categoriaPath).toBeNull();
    expect(body.listingTypeId).toBeNull();
    expect(h.getCategory.mock.calls.length).toBeLessThanOrEqual(6);
    // It must not go asking for types it cannot use.
    expect(h.getCategoryListingTypes).not.toHaveBeenCalled();
  });

  it('leaves the listing type for the operator when only Premium is offered', async () => {
    // Silently choosing a Premium listing is the one outcome the rule exists to
    // prevent — «não se deve publicar em "gold" nem "gold_premium"».
    h.getCategoryListingTypes.mockResolvedValue([{ id: 'gold_pro' }, { id: 'gold_premium' }]);
    const body = (await (await GET(req())).json()) as Body;
    expect(body.categoryId).toBe('MLB5672');
    expect(body.listingTypeId).toBeNull();
  });

  it('flags ML’s own test-user nickname format', async () => {
    // `TETE…`, from this repo's captured test-user order (`orderMLWire.test.ts`).
    const body = (await (await GET(req())).json()) as Body;
    expect(body.conta).toEqual({ nickname: 'TETE8127263', ehContaDeTeste: true });
  });

  it('flags a real seller account, which ML forbids for testing', async () => {
    h.getMe.mockResolvedValue({ id: 2, nickname: 'VESTEFRANCE' });
    const body = (await (await GET(req())).json()) as Body;
    expect(body.conta.ehContaDeTeste).toBe(false);
  });

  it('maps an ML failure to the shared error response', async () => {
    h.listSiteCategories.mockRejectedValue(new MercadoLivreHttpError('boom', 500, {}));
    expect((await GET(req())).status).toBe(502);
  });
});
