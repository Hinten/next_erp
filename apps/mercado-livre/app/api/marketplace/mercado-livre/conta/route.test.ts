import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MercadoLivreHttpError,
  MercadoLivreReauthRequiredError,
} from '@delfrance/integrations-mercado-livre';

// verifyCaller and the ML context loader are mocked; the route's own logic
// (param validation, connected/disconnected mapping, error mapping) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
}));

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
    createMercadoLivreApi: () => ({ getMe: h.getMe }),
  };
});

const { GET } = await import('./route');

function req(params: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3006/api/marketplace/mercado-livre/conta');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.resolveChannelContext.mockResolvedValue({
    integracaoId: 'int-1',
    accessToken: 'AT',
    account: {},
  });
  h.loadCtx.mockResolvedValue({
    integracaoId: 'int-1',
    resolveChannelContext: h.resolveChannelContext,
  });
  h.getMe.mockResolvedValue({ id: 42, nickname: 'LOJA', email: 'a@b.c', site_id: 'MLB' });
});

describe('GET /api/marketplace/mercado-livre/conta', () => {
  it('returns connected + the /users/me identity when a token resolves', async () => {
    const res = await GET(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connected: true,
      me: { id: 42, nickname: 'LOJA', email: 'a@b.c' },
    });
  });

  it('400s without integracaoId', async () => {
    const res = await GET(req());
    expect(res.status).toBe(400);
  });

  it('returns connected:false (200) when the credential is dead/absent', async () => {
    h.resolveChannelContext.mockRejectedValue(
      new MercadoLivreReauthRequiredError('no_token', 'não conectada'),
    );
    const res = await GET(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, me: null });
  });

  it('maps an upstream ML HTTP failure through the error mapper (502)', async () => {
    h.getMe.mockRejectedValue(new MercadoLivreHttpError('ML 500: boom', 500, {}));
    const res = await GET(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(502);
  });

  it('propagates the auth failure response from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await GET(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(403);
  });
});
