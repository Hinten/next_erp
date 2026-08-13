import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';

import { verifyState } from '@/lib/freight/state';

// Mock the two seams: admin auth (drives verifyCaller) and the ME context
// loader (sidesteps Firestore + the token store + the ME API). signState /
// verifyState stay REAL so the round-trip the callback relies on is genuine.
const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  putOauthState: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/freight/melhorEnvio', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/freight/melhorEnvio')>();
  return { ...actual, loadMelhorEnvioContext: h.loadCtx };
});

// The attempt record is Firestore-backed; only its inputs matter here.
vi.mock('@/lib/freight/oauthState', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/freight/oauthState')>();
  return {
    ...actual,
    melhorEnvioOauthState: { ...actual.melhorEnvioOauthState, put: h.putOauthState },
  };
});

const { GET } = await import('./route');

const STATE_SECRET = 'test-state-secret';

const OAUTH_CONFIG = {
  baseUrl: 'https://sandbox.melhorenvio.com.br',
  clientId: 'cid-123',
  clientSecret: 'csecret',
  redirectUri: 'http://localhost:3001/api/oauth/melhor-envio/callback',
  userAgent: 'test-agent',
};

function req(intFreteId?: string, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3001/api/freight/melhor-envio/oauth/start');
  if (intFreteId !== undefined) url.searchParams.set('intFreteId', intFreteId);
  return new Request(url, { headers });
}

const WRITER = { uid: 'u1', permissions: (PERM.frete.read | PERM.frete.write).toString() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MELHOR_ENVIO_STATE_SECRET', STATE_SECRET);
  h.loadCtx.mockResolvedValue({ intFreteId: 'int-1', oauthConfig: OAUTH_CONFIG });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/freight/melhor-envio/oauth/start', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await GET(req('int-1'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a caller without frete.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: PERM.frete.read.toString() });
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when intFreteId is missing', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req(undefined, { authorization: 'Bearer t' }));
    expect(res.status).toBe(400);
  });

  it('returns 500 when MELHOR_ENVIO_STATE_SECRET is not configured', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    vi.stubEnv('MELHOR_ENVIO_STATE_SECRET', '');
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(500);
  });

  it('returns the authorize URL with the env client_id, redirect_uri and a verifiable state', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);

    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe(OAUTH_CONFIG.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(OAUTH_CONFIG.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');

    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    // The signed state must round-trip back to the same int_frete id.
    expect(verifyState(state!, STATE_SECRET).id).toBe('int-1');

    expect(h.loadCtx).toHaveBeenCalledWith(expect.anything(), 'int-1');
  });

  it('records the attempt under the SAME nonce the state carries', async () => {
    // The binding that makes the state single-use: if the persisted nonce and
    // the one inside the state ever diverge, the callback can never redeem a
    // legitimate attempt.
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get('state')!;

    expect(h.putOauthState).toHaveBeenCalledTimes(1);
    expect(h.putOauthState).toHaveBeenCalledWith(expect.anything(), 'int-1', {
      nonce: verifyState(state, STATE_SECRET).nonce,
      // Melhor Envio documents no PKCE — nothing secret is parked for a flow
      // that will never present a verifier.
      codeVerifier: null,
    });
  });

  it('sends no PKCE parameters — Melhor Envio does not support them', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBeNull();
  });
});
