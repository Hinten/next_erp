import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MercadoPagoHttpError,
  MercadoPagoReauthRequiredError,
} from '@delfrance/integrations-mercado-pago';

// verifyCaller and the MP context loader are mocked; the route's own logic
// (param validation, connected/disconnected mapping, error mapping) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveAccessToken: vi.fn(),
  getMe: vi.fn(),
  merge: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  metodoPagamentoCollection: { merge: h.merge },
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/payments/mercadoPago', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/payments/mercadoPago')>();
  return { ...actual, loadMercadoPagoContext: h.loadCtx };
});

vi.mock('@delfrance/integrations-mercado-pago', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-pago')>();
  return {
    ...actual,
    createMercadoPagoApi: () => ({ getMe: h.getMe }),
  };
});

const { GET } = await import('./route');

function req(params: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3007/api/payments/mercado-pago/conta');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1' } });
  h.resolveAccessToken.mockResolvedValue('AT');
  h.loadCtx.mockResolvedValue({
    metodoId: 'm1',
    conta: { user_id: 4242 },
    resolveAccessToken: h.resolveAccessToken,
  });
  h.getMe.mockResolvedValue({ id: 4242, nickname: 'LOJA', email: 'a@b.c', site_id: 'MLB' });
});

describe('GET /api/payments/mercado-pago/conta', () => {
  it('heals a drifted user_id denorm when connected', async () => {
    // e.g. the callback's merge failed after the credential was persisted.
    h.loadCtx.mockResolvedValue({
      metodoId: 'm1',
      conta: { user_id: null },
      resolveAccessToken: h.resolveAccessToken,
    });
    const res = await GET(req({ metodoId: 'm1' }));
    expect(res.status).toBe(200);
    expect(h.merge).toHaveBeenCalledWith({}, {}, 'm1', { user_id: 4242 });
  });

  it('does not rewrite user_id when the denorm already matches', async () => {
    const res = await GET(req({ metodoId: 'm1' }));
    expect(res.status).toBe(200);
    expect(h.merge).not.toHaveBeenCalled();
  });

  it('returns connected + the /users/me identity when a token resolves', async () => {
    const res = await GET(req({ metodoId: 'm1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connected: true,
      me: { id: 4242, nickname: 'LOJA', email: 'a@b.c' },
    });
  });

  it('400s without metodoId', async () => {
    const res = await GET(req());
    expect(res.status).toBe(400);
  });

  it('returns connected:false (200) when the credential is dead/absent', async () => {
    h.resolveAccessToken.mockRejectedValue(
      new MercadoPagoReauthRequiredError('no_token', 'não conectada'),
    );
    const res = await GET(req({ metodoId: 'm1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, me: null });
  });

  it('maps an upstream MP HTTP failure through the error mapper (502)', async () => {
    h.getMe.mockRejectedValue(new MercadoPagoHttpError('MP 500: boom', 500, {}));
    const res = await GET(req({ metodoId: 'm1' }));
    expect(res.status).toBe(502);
  });

  it('propagates the auth failure response from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await GET(req({ metodoId: 'm1' }));
    expect(res.status).toBe(403);
  });
});
