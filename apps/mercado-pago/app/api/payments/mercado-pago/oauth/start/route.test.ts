import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';

import { verifyState } from '@/lib/payments/state';

// Mock the two seams: admin auth (drives verifyCaller) and the MP context loader
// (sidesteps Firestore + the credential store). signState / verifyState stay REAL
// so the state the callback relies on genuinely round-trips.
const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  putOauthState: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/payments/mercadoPago', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/payments/mercadoPago')>();
  return { ...actual, loadMercadoPagoContext: h.loadCtx };
});

// The attempt record is Firestore-backed; only its inputs matter here.
vi.mock('@/lib/payments/oauthState', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/payments/oauthState')>();
  return {
    ...actual,
    mercadoPagoOauthState: { ...actual.mercadoPagoOauthState, put: h.putOauthState },
  };
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
  vi.stubEnv('MERCADO_PAGO_PKCE_ENABLED', '');
  h.putOauthState.mockResolvedValue(undefined);
  // The mocked context's authorizeUrl echoes the state (and any PKCE parameters)
  // into the consent URL, the same way `buildAuthorizeUrl` does, so the test can
  // verify what the route actually handed to the context.
  h.loadCtx.mockResolvedValue({
    metodoId: 'm1',
    authorizeUrl: (
      state: string,
      pkce?: { codeChallenge: string; codeChallengeMethod?: 'S256' | 'plain' },
    ) => {
      const url = new URL('https://auth.mercadopago.com.br/authorization');
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
    expect(verifyState(state!, STATE_SECRET).id).toBe('m1');
    expect(h.loadCtx).toHaveBeenCalledWith(expect.anything(), 'm1');
  });

  it('records the attempt under the SAME nonce the state carries', async () => {
    // The binding that makes the state single-use: if the persisted nonce and
    // the one inside the state ever diverge, the callback can never redeem a
    // legitimate attempt.
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req('m1', { authorization: 'Bearer t' }));

    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get('state')!;

    expect(h.putOauthState).toHaveBeenCalledTimes(1);
    expect(h.putOauthState).toHaveBeenCalledWith(expect.anything(), 'm1', {
      nonce: verifyState(state, STATE_SECRET).nonce,
      codeVerifier: null,
    });
  });

  it('omits the PKCE parameters while the flag is off', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req('m1', { authorization: 'Bearer t' }));

    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBeNull();
    // …and nothing secret is parked for a flow that will not present one.
    expect(h.putOauthState.mock.calls[0]?.[2]).toMatchObject({ codeVerifier: null });
  });

  it('sends an S256 challenge derived from the stored verifier when PKCE is on', async () => {
    // ⚠️ MP enables PKCE per registered application, and its docs are explicit
    // that the toggle makes these parameters MANDATORY — so this flag and the
    // dashboard toggle are flipped together.
    vi.stubEnv('MERCADO_PAGO_PKCE_ENABLED', '1');
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req('m1', { authorization: 'Bearer t' }));

    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const { codeVerifier } = h.putOauthState.mock.calls[0]![2] as { codeVerifier: string };
    expect(codeVerifier).toEqual(expect.any(String));
    // RFC 7636 §4.1: 43..128 chars from the unreserved set.
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    // The challenge on the wire MUST be the SHA-256 of the verifier we kept — a
    // mismatch fails the exchange with `invalid_grant` at the worst moment.
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(codeVerifier).digest('base64url'),
    );
    // The verifier itself never leaves the backend.
    expect(authorizeUrl).not.toContain(codeVerifier);
  });
});
