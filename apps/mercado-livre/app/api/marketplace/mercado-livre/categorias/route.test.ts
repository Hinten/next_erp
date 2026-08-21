import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  listSiteCategories: vi.fn(),
  getCategory: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/core/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/core/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return {
    ...actual,
    createMercadoLivreApi: () => ({
      listSiteCategories: h.listSiteCategories,
      getCategory: h.getCategory,
    }),
  };
});

const { GET } = await import('./route');

const req = (qs: string) =>
  new Request(`http://localhost:3006/api/marketplace/mercado-livre/categorias${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  // The metadata caches are module-scoped and survive between test files.
  __resetAllReadCaches();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.resolveChannelContext.mockResolvedValue({ integracaoId: 'i', accessToken: 'AT', account: {} });
  h.loadCtx.mockResolvedValue({ resolveChannelContext: h.resolveChannelContext });
  h.listSiteCategories.mockResolvedValue([
    { id: 'MLB1000', name: 'Eletrônicos' },
    { id: 'MLB1430', name: 'Roupas' },
  ]);
  h.getCategory.mockResolvedValue({
    id: 'MLB31447',
    name: 'Camisetas',
    path_from_root: [
      { id: 'MLB1430', name: 'Roupas' },
      { id: 'MLB31447', name: 'Camisetas' },
    ],
    children_categories: [],
    settings: { catalog_domain: 'MLB-T_SHIRTS' },
  });
});

describe('GET /api/marketplace/mercado-livre/categorias', () => {
  it('rejects an unauthorized caller', async () => {
    h.verifyCaller.mockResolvedValue({ error: new Response(null, { status: 403 }) });
    expect((await GET(req('?integracaoId=int-1'))).status).toBe(403);
  });

  it('400s without integracaoId', async () => {
    expect((await GET(req(''))).status).toBe(400);
  });

  it('returns the tree roots when no categoryId is given', async () => {
    const res = await GET(req('?integracaoId=int-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roots: [
        { id: 'MLB1000', name: 'Eletrônicos' },
        { id: 'MLB1430', name: 'Roupas' },
      ],
      node: null,
    });
    expect(h.getCategory).not.toHaveBeenCalled();
  });

  it('returns the node with its breadcrumb, children and leaf flag', async () => {
    const res = await GET(req('?integracaoId=int-1&categoryId=MLB31447'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roots: null,
      node: {
        id: 'MLB31447',
        name: 'Camisetas',
        pathFromRoot: [
          { id: 'MLB1430', name: 'Roupas' },
          { id: 'MLB31447', name: 'Camisetas' },
        ],
        children: [],
        isLeaf: true,
        // The chart binding reads settings.catalog_domain (publish.ts:460).
        settings: { catalog_domain: 'MLB-T_SHIRTS' },
      },
    });
  });

  it('marks a mid-tree node as not a leaf', async () => {
    h.getCategory.mockResolvedValue({
      id: 'MLB1430',
      name: 'Roupas',
      children_categories: [{ id: 'MLB31447', name: 'Camisetas' }],
    });
    const body = (await (await GET(req('?integracaoId=int-1&categoryId=MLB1430'))).json()) as {
      node: { isLeaf: boolean; children: unknown[] };
    };
    expect(body.node.isLeaf).toBe(false);
    expect(body.node.children).toEqual([{ id: 'MLB31447', name: 'Camisetas' }]);
  });

  it('serves a repeat request from the cache without re-asking ML', async () => {
    await GET(req('?integracaoId=int-1&categoryId=MLB31447'));
    await GET(req('?integracaoId=int-1&categoryId=MLB31447'));
    expect(h.getCategory).toHaveBeenCalledTimes(1);
  });

  it('maps an ML failure to the shared error response', async () => {
    h.getCategory.mockRejectedValue(new MercadoLivreHttpError('category not found', 404, {}));
    expect((await GET(req('?integracaoId=int-1&categoryId=NOPE'))).status).toBe(502);
  });
});
