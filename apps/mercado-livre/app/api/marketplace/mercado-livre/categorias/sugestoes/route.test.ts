import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  suggestCategories: vi.fn(),
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
    createMercadoLivreApi: () => ({ suggestCategories: h.suggestCategories }),
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
        },
        {
          categoryId: 'MLB108704',
          categoryName: 'Regatas',
          domainId: null,
          domainName: null,
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
