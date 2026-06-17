import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { MelhorEnvioReauthRequiredError } from '@delfrance/integrations-freight-br';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  getMe: vi.fn(),
  getBalance: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/freight/melhorEnvio', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/freight/melhorEnvio')>();
  return { ...actual, loadMelhorEnvioContext: h.loadCtx };
});

const { GET } = await import('./route');

function req(intFreteId?: string, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3001/api/freight/melhor-envio/conta');
  if (intFreteId !== undefined) url.searchParams.set('intFreteId', intFreteId);
  return new Request(url, { headers });
}

const READER = { uid: 'u1', permissions: PERM.frete.read.toString() };

beforeEach(() => {
  vi.clearAllMocks();
  h.loadCtx.mockResolvedValue({
    intFreteId: 'int-1',
    api: { getMe: h.getMe, getBalance: h.getBalance },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/freight/melhor-envio/conta', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await GET(req('int-1'));
    expect(res.status).toBe(401);
  });

  it('returns 400 when intFreteId is missing', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    const res = await GET(req(undefined, { authorization: 'Bearer t' }));
    expect(res.status).toBe(400);
  });

  it('returns 200 with connected:true plus me and balance', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    h.getMe.mockResolvedValue({ id: 'me-1', email: 'lojista@example.com' });
    h.getBalance.mockResolvedValue({ balance: 42.5 });

    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connected: true,
      me: { id: 'me-1', email: 'lojista@example.com' },
      balance: { balance: 42.5 },
    });
  });

  it('returns 200 with connected:false when the account needs re-auth', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    h.getMe.mockRejectedValue(
      new MelhorEnvioReauthRequiredError('no_token', 'Conta não conectada.'),
    );

    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, me: null, balance: null });
  });
});
