import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  suggestCategories: vi.fn(),
  getCategory: vi.fn(),
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
      suggestCategories: h.suggestCategories,
      getCategory: h.getCategory,
    }),
  };
});

const { GET } = await import('./route');

const req = (qs: string) =>
  new Request(`http://localhost:3006/api/marketplace/mercado-livre/categorias/sugestoes${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllReadCaches();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.resolveChannelContext.mockResolvedValue({ integracaoId: 'i', accessToken: 'AT', account: {} });
  h.loadCtx.mockResolvedValue({ resolveChannelContext: h.resolveChannelContext });
  h.suggestCategories.mockResolvedValue([
    {
      category_id: 'MLB31447',
      category_name: 'Camisetas',
      domain_id: 'MLB-T_SHIRTS',
      domain_name: 'Camisetas',
    },
    { category_id: 'MLB108704', category_name: 'Regatas' },
  ]);
  // `domain_discovery/search` carries NO path, so the route resolves one per
  // suggestion through the shared category cache.
  h.getCategory.mockImplementation(async (id: string) => ({
    id,
    name: id === 'MLB31447' ? 'Camisetas' : 'Regatas',
    path_from_root: [
      { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
      { id, name: id === 'MLB31447' ? 'Camisetas' : 'Regatas' },
    ],
  }));
});

describe('GET /api/marketplace/mercado-livre/categorias/sugestoes', () => {
  it('rejects an unauthorized caller', async () => {
    h.verifyCaller.mockResolvedValue({ error: new Response(null, { status: 403 }) });
    expect((await GET(req('?integracaoId=int-1&q=camiseta'))).status).toBe(403);
  });

  it('400s without integracaoId, and on a too-short query', async () => {
    expect((await GET(req('?q=camiseta'))).status).toBe(400);
    expect((await GET(req('?integracaoId=int-1&q=c'))).status).toBe(400);
    expect((await GET(req('?integracaoId=int-1&q=%20%20'))).status).toBe(400);
  });

  it('returns the FULL ranked list for a human to choose from', async () => {
    // The whole point of #799: publish used to take suggestCategories(nome,1)[0]
    // with no human in the loop, so a wrong first hit only surfaced once the
    // listing existed in the wrong category on a live marketplace.
    const res = await GET(req('?integracaoId=int-1&q=camiseta%20basica'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sugestoes: [
        {
          categoryId: 'MLB31447',
          categoryName: 'Camisetas',
          domainId: 'MLB-T_SHIRTS',
          domainName: 'Camisetas',
          pathFromRoot: [
            { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
            { id: 'MLB31447', name: 'Camisetas' },
          ],
        },
        {
          categoryId: 'MLB108704',
          categoryName: 'Regatas',
          domainId: null,
          domainName: null,
          pathFromRoot: [
            { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
            { id: 'MLB108704', name: 'Regatas' },
          ],
        },
      ],
    });
  });

  it('clamps the limit into ML-picker range', async () => {
    await GET(req('?integracaoId=int-1&q=camiseta&limit=999'));
    expect(h.suggestCategories).toHaveBeenCalledWith('camiseta', 8);
    h.suggestCategories.mockClear();
    __resetAllReadCaches();
    await GET(req('?integracaoId=int-1&q=camiseta&limit=0'));
    expect(h.suggestCategories).toHaveBeenCalledWith('camiseta', 1);
  });

  it('never caches an empty result', async () => {
    // The key space is every prefix an operator types; a miss for a half-typed
    // title must not greet the finished one.
    h.suggestCategories.mockResolvedValue([]);
    await GET(req('?integracaoId=int-1&q=cami'));
    await GET(req('?integracaoId=int-1&q=cami'));
    expect(h.suggestCategories).toHaveBeenCalledTimes(2);
  });

  it('maps an ML failure to the shared error response', async () => {
    h.suggestCategories.mockRejectedValue(new MercadoLivreHttpError('boom', 500, {}));
    expect((await GET(req('?integracaoId=int-1&q=camiseta'))).status).toBe(502);
  });
});

describe('the ancestor path on each suggestion', () => {
  it('resolves a path per suggestion, because the search endpoint sends none', async () => {
    // ⚠️ `domain_discovery/search` returns only `category_name`, the LEAF. ML
    // files the same leaf under several parents, so without this the picker
    // rendered "Camisetas e Regatas" five times over, told apart only by an
    // opaque MLB id.
    await GET(req('?integracaoId=int-1&q=camiseta'));
    expect(h.getCategory).toHaveBeenCalledWith('MLB31447');
    expect(h.getCategory).toHaveBeenCalledWith('MLB108704');
  });

  it('shares one cached category read across suggestions and repeat calls', async () => {
    // ML category metadata is GLOBAL, not per-seller, so sibling suggestions
    // share ancestors and the cascade the operator then walks hits the same
    // entries. Two identical requests must cost one round of reads.
    await GET(req('?integracaoId=int-1&q=camiseta'));
    const first = h.getCategory.mock.calls.length;
    await GET(req('?integracaoId=int-1&q=camiseta'));
    expect(h.getCategory.mock.calls.length).toBe(first);
  });

  it('degrades ONE suggestion to a null path instead of failing the list', async () => {
    // A metadata read that fails must not cost the operator the whole
    // suggestion list — the row stays selectable with its leaf name.
    h.getCategory.mockImplementation(async (id: string) => {
      if (id === 'MLB108704') throw new MercadoLivreHttpError('nope', 404, {});
      return { id, name: 'Camisetas', path_from_root: [{ id, name: 'Camisetas' }] };
    });

    const res = await GET(req('?integracaoId=int-1&q=camiseta'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sugestoes: Array<{ categoryId: string; pathFromRoot: unknown }>;
    };
    expect(body.sugestoes).toHaveLength(2);
    expect(body.sugestoes[1]).toMatchObject({ categoryId: 'MLB108704', pathFromRoot: null });
  });

  it('reports a null path when ML sends an empty path_from_root', async () => {
    h.getCategory.mockResolvedValue({ id: 'x', name: 'x', path_from_root: [] });
    const res = await GET(req('?integracaoId=int-1&q=camiseta'));
    const body = (await res.json()) as { sugestoes: Array<{ pathFromRoot: unknown }> };
    expect(body.sugestoes.every((s) => s.pathFromRoot === null)).toBe(true);
  });

  it('rethrows a NON-ML error rather than hiding it as a missing path', async () => {
    // A bug in our own code must surface, not be disguised as ML metadata that
    // happened to be unavailable.
    h.getCategory.mockRejectedValue(new TypeError('cannot read property of undefined'));
    await expect(GET(req('?integracaoId=int-1&q=camiseta'))).rejects.toBeInstanceOf(TypeError);
  });
});
