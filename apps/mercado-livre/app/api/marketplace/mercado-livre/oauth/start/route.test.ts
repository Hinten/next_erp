import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';

import { verifyState } from '@/lib/marketplace/core/state';

// Mock the two seams: admin auth (drives verifyCaller) and the ML context loader
// (sidesteps Firestore + the credential store + the plugin). signState /
// verifyState stay REAL so the state the callback relies on genuinely round-trips.
const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/marketplace/core/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/core/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

const { GET } = await import('./route');

const STATE_SECRET = 'test-state-secret';
const REDIRECT_URI = 'http://localhost:3006/api/oauth/mercado-livre/callback';

function req(integracaoId?: string, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3006/api/marketplace/mercado-livre/oauth/start');
  if (integracaoId !== undefined) url.searchParams.set('integracaoId', integracaoId);
  return new Request(url, { headers });
}

const WRITER = {
  uid: 'u1',
  permissions: (PERM.integracao.read | PERM.integracao.write).toString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MERCADO_LIVRE_STATE_SECRET', STATE_SECRET);
  // The mocked context's channel echoes the state into the authorize URL so the
  // test can verify the signed state round-trips.
  h.loadCtx.mockResolvedValue({
    integracaoId: 'int-1',
    channel: {
      id: 'mercado-livre',
      oauthFlow: {
        start: (state: string) =>
          `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=CID&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`,
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/marketplace/mercado-livre/oauth/start', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await GET(req('int-1'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a caller without integracao.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: PERM.integracao.read.toString() });
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when integracaoId is missing', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req(undefined, { authorization: 'Bearer t' }));
    expect(res.status).toBe(400);
  });

  it('returns 500 when MERCADO_LIVRE_STATE_SECRET is not configured', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    vi.stubEnv('MERCADO_LIVRE_STATE_SECRET', '');
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(500);
  });

  it('returns the authorize URL with client_id, redirect_uri and a verifiable state', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);

    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe('CID');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');

    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    // The signed state must round-trip back to the same integracao id.
    expect(verifyState(state!, STATE_SECRET).integracaoId).toBe('int-1');
    expect(h.loadCtx).toHaveBeenCalledWith(expect.anything(), 'int-1');
  });
});
