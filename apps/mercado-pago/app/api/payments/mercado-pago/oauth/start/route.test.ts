import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';

import { verifyState } from '@/lib/payments/state';

// Mock the two seams: admin auth (drives verifyCaller) and the MP context loader
// (sidesteps Firestore + the credential store). signState / verifyState stay REAL
// so the state the callback relies on genuinely round-trips.
const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/payments/mercadoPago', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/payments/mercadoPago')>();
  return { ...actual, loadMercadoPagoContext: h.loadCtx };
});

const { GET } = await import('./route');

const STATE_SECRET = 'test-state-secret';
const REDIRECT_URI = 'http://localhost:3007/api/oauth/mercado-pago/callback';

function req(metodoId?: string, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3007/api/payments/mercado-pago/oauth/start');
  if (metodoId !== undefined) url.searchParams.set('metodoId', metodoId);
  return new Request(url, { headers });
}

const WRITER = {
  uid: 'u1',
  permissions: (PERM.metodoPagamento.read | PERM.metodoPagamento.write).toString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MERCADO_PAGO_STATE_SECRET', STATE_SECRET);
  // The mocked context's authorizeUrl echoes the state into the consent URL so
  // the test can verify the signed state round-trips.
  h.loadCtx.mockResolvedValue({
    metodoId: 'm1',
    authorizeUrl: (state: string) =>
      `https://auth.mercadopago.com.br/authorization?response_type=code&client_id=CID&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/payments/mercado-pago/oauth/start', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await GET(req('m1'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a caller without metodoPagamento.write', async () => {
    h.verifyIdToken.mockResolvedValue({
      uid: 'u1',
      permissions: PERM.metodoPagamento.read.toString(),
    });
    const res = await GET(req('m1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when metodoId is missing', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req(undefined, { authorization: 'Bearer t' }));
    expect(res.status).toBe(400);
  });

  it('returns 500 when MERCADO_PAGO_STATE_SECRET is not configured', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    vi.stubEnv('MERCADO_PAGO_STATE_SECRET', '');
    const res = await GET(req('m1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(500);
  });

  it('returns the authorize URL with client_id, redirect_uri and a verifiable state', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req('m1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);

    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe('CID');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');

    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    // The signed state must round-trip back to the same metodo_pgto id.
    expect(verifyState(state!, STATE_SECRET).metodoId).toBe('m1');
    expect(h.loadCtx).toHaveBeenCalledWith(expect.anything(), 'm1');
  });
});
