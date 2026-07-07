import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  getActiveChartDomains: vi.fn(),
  getCatalogDomain: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
}));

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
      getActiveChartDomains: h.getActiveChartDomains,
      getCatalogDomain: h.getCatalogDomain,
    }),
  };
});

const { GET } = await import('./route');

const req = (qs: string) =>
  new Request(`http://localhost:3006/api/marketplace/mercado-livre/size-charts/domains${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.resolveChannelContext.mockResolvedValue({ integracaoId: 'i', accessToken: 'AT', account: {} });
  h.loadCtx.mockResolvedValue({ resolveChannelContext: h.resolveChannelContext });
  h.getActiveChartDomains.mockResolvedValue({
    domains: [{ domain_id: 'MLB-PANTS' }, { domain_id: 'MLB-T_SHIRTS' }],
  });
  h.getCatalogDomain.mockImplementation(async (id: string) =>
    id === 'MLB-PANTS' ? { id, name: 'Calças' } : { id, name: 'Camisetas' },
  );
});

describe('GET /api/marketplace/mercado-livre/size-charts/domains', () => {
  it('returns the active chart domains enriched with labels', async () => {
    const res = await GET(req('?integracaoId=int-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      domains: [
        { domain_id: 'MLB-PANTS', name: 'Calças' },
        { domain_id: 'MLB-T_SHIRTS', name: 'Camisetas' },
      ],
    });
  });

  it('a single failing domain label degrades to null instead of breaking', async () => {
    h.getCatalogDomain.mockImplementation(async (id: string) => {
      if (id === 'MLB-PANTS') throw new MercadoLivreHttpError('nope', 404, {});
      return { id, name: 'Camisetas' };
    });
    const res = await GET(req('?integracaoId=int-1'));
    const body = await res.json();
    expect(body.domains).toContainEqual({ domain_id: 'MLB-PANTS', name: null });
    expect(body.domains).toContainEqual({ domain_id: 'MLB-T_SHIRTS', name: 'Camisetas' });
  });

  it('400s without integracaoId', async () => {
    expect((await GET(req(''))).status).toBe(400);
  });
});
