import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  getDomainTechnicalSpecs: vi.fn(),
  getGridTechnicalSpecs: vi.fn(),
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
      getDomainTechnicalSpecs: h.getDomainTechnicalSpecs,
      getGridTechnicalSpecs: h.getGridTechnicalSpecs,
    }),
  };
});

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/size-charts/specs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.resolveChannelContext.mockResolvedValue({ integracaoId: 'i', accessToken: 'AT', account: {} });
  h.loadCtx.mockResolvedValue({ resolveChannelContext: h.resolveChannelContext });
  h.getDomainTechnicalSpecs.mockResolvedValue({ groups: [{ section: 'GRIDS' }] });
  h.getGridTechnicalSpecs.mockResolvedValue({ groups: [{ section: 'GRIDS', concrete: true }] });
});

describe('POST /api/marketplace/mercado-livre/size-charts/specs', () => {
  it('without attributes → full domain spec', async () => {
    const res = await POST(req({ integracaoId: 'int-1', domainId: 'MLB-PANTS' }));
    expect(res.status).toBe(200);
    expect(h.getDomainTechnicalSpecs).toHaveBeenCalledWith('MLB-PANTS');
    expect(h.getGridTechnicalSpecs).not.toHaveBeenCalled();
  });

  it('with attributes → the ?section=grids variant (old-app body shape)', async () => {
    const attributes = [{ id: 'GENDER', value_id: '339665' }];
    const res = await POST(req({ integracaoId: 'int-1', domainId: 'MLB-PANTS', attributes }));
    expect(res.status).toBe(200);
    expect(h.getGridTechnicalSpecs).toHaveBeenCalledWith('MLB-PANTS', attributes);
  });

  it('400s on missing fields and non-object bodies', async () => {
    expect((await POST(req({ domainId: 'MLB-PANTS' }))).status).toBe(400);
    expect((await POST(req({ integracaoId: 'int-1' }))).status).toBe(400);
    // Legal JSON that isn't an object must 400, not crash to a 500.
    expect((await POST(req(null))).status).toBe(400);
    expect((await POST(req([1]))).status).toBe(400);
  });
});
