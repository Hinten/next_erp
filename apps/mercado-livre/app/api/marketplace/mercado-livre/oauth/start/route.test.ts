import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';

import { verifyState } from '@delfrance/data/admin/oauth-state';

// Mock the two seams: admin auth (drives verifyCaller) and the ML context loader
// (sidesteps Firestore + the credential store + the plugin). signState /
// verifyState stay REAL so the state the callback relies on genuinely round-trips.
const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  putOauthState: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/marketplace/core/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/core/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

// The attempt record is Firestore-backed; only its inputs matter here.
vi.mock('@/lib/marketplace/conta/oauthState', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/conta/oauthState')>();
  return {
    ...actual,
    mercadoLivreOauthState: { ...actual.mercadoLivreOauthState, put: h.putOauthState },
  };
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
  vi.stubEnv('MERCADO_LIVRE_PKCE_ENABLED', '');
  h.putOauthState.mockResolvedValue(undefined);
  // The mocked context's channel echoes the state (and any PKCE parameters)
  // into the authorize URL, the same way `buildAuthorizeUrl` does, so the test
  // can verify what the route actually handed to the plugin.
  h.loadCtx.mockResolvedValue({
    integracaoId: 'int-1',
    channel: {
      id: 'mercado-livre',
      oauthFlow: {
        start: (
          state: string,
          pkce?: { codeChallenge: string; codeChallengeMethod?: 'S256' | 'plain' },
        ) => {
          const url = new URL('https://auth.mercadolivre.com.br/authorization');
          url.searchParams.set('response_type', 'code');
          url.searchParams.set('client_id', 'CID');
          url.searchParams.set('redirect_uri', REDIRECT_URI);
          url.searchParams.set('state', state);
          if (pkce) {
            url.searchParams.set('code_challenge', pkce.codeChallenge);
            url.searchParams.set('code_challenge_method', pkce.codeChallengeMethod ?? 'S256');
          }
          return url.toString();
        },
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
      codeVerifier: null,
    });
  });

  it('omits the PKCE parameters while the flag is off', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBeNull();
    // …and nothing secret is parked for a flow that will not present one.
    expect(h.putOauthState.mock.calls[0]?.[2]).toMatchObject({ codeVerifier: null });
  });

  it('sends an S256 challenge derived from the stored verifier when PKCE is on', async () => {
    vi.stubEnv('MERCADO_LIVRE_PKCE_ENABLED', '1');
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const { codeVerifier } = h.putOauthState.mock.calls[0]![2] as { codeVerifier: string };
    expect(codeVerifier).toEqual(expect.any(String));
    // RFC 7636 §4.1: 43..128 chars from the unreserved set.
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    // The challenge on the wire MUST be the SHA-256 of the verifier we kept —
    // a mismatch fails the exchange with `invalid_grant` at the worst moment.
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(codeVerifier).digest('base64url'),
    );
    // The verifier itself never leaves the backend.
    expect(authorizeUrl).not.toContain(codeVerifier);
  });
});
