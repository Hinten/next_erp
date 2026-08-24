import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  getCategory: vi.fn(),
  getCategoryListingTypes: vi.fn(),
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
      getCategory: h.getCategory,
      getCategoryListingTypes: h.getCategoryListingTypes,
    }),
  };
});

const { GET } = await import('./route');

const req = (qs: string) =>
  new Request(`http://localhost:3006/api/marketplace/mercado-livre/tipos-anuncio${qs}`);

const LEAF = '?integracaoId=int-1&categoryId=MLB31447';

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllReadCaches();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.resolveChannelContext.mockResolvedValue({ integracaoId: 'i', accessToken: 'AT', account: {} });
  h.loadCtx.mockResolvedValue({ resolveChannelContext: h.resolveChannelContext });
  h.getCategory.mockResolvedValue({ id: 'MLB31447', children_categories: [] });
  h.getCategoryListingTypes.mockResolvedValue([
    { id: 'gold_special', name: 'Clássico' },
    { id: 'gold_pro', name: 'Premium' },
    { id: 'free', name: 'Grátis' },
  ]);
});

describe('GET /api/marketplace/mercado-livre/tipos-anuncio', () => {
  it('rejects an unauthorized caller', async () => {
    h.verifyCaller.mockResolvedValue({ error: new Response(null, { status: 403 }) });
    expect((await GET(req(LEAF))).status).toBe(403);
  });

  it('400s without integracaoId or categoryId', async () => {
    expect((await GET(req('?categoryId=MLB31447'))).status).toBe(400);
    expect((await GET(req('?integracaoId=int-1'))).status).toBe(400);
  });

  it('returns what ML actually offers, not the two hard-coded options', async () => {
    // MercadoLivreManager.tsx:69-72 shipped exactly gold_special + gold_pro for
    // every category. Which types exist is a per-category answer.
    const res = await GET(req(LEAF));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      leaf: true,
      tipos: [
        { id: 'gold_special', name: 'Clássico' },
        { id: 'gold_pro', name: 'Premium' },
        { id: 'free', name: 'Grátis' },
      ],
    });
  });

  it('short-circuits a mid-tree category without calling ML for types', async () => {
    h.getCategory.mockResolvedValue({ id: 'MLB1430', children_categories: [{ id: 'MLB31447' }] });
    const res = await GET(req('?integracaoId=int-1&categoryId=MLB1430'));
    expect(await res.json()).toEqual({ leaf: false, tipos: [] });
    expect(h.getCategoryListingTypes).not.toHaveBeenCalled();
  });

  it('maps an ML failure to the shared error response', async () => {
    h.getCategoryListingTypes.mockRejectedValue(new MercadoLivreHttpError('boom', 500, {}));
    expect((await GET(req(LEAF))).status).toBe(502);
  });
});
