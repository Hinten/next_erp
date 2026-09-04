import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { verifyState } from '@delfrance/data/admin/oauth-state';
import { SHOPEE_SANDBOX_AUTH_HOST } from '@delfrance/integrations-shopee';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';

/**
 * Two seams are mocked: admin auth (which drives `verifyCaller`) and the Shopee
 * context loader (which would otherwise reach Firestore). `signState` /
 * `verifyState` and `buildAuthorizeUrl` stay REAL, so the state genuinely
 * round-trips and the asserted URL shape is the one Shopee will receive.
 */
const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  putOauthState: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/shopee/core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

vi.mock('@/lib/shopee/conta/oauthState', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/conta/oauthState')>();
  return { ...actual, shopeeOauthState: { ...actual.shopeeOauthState, put: h.putOauthState } };
});

const { GET } = await import('./route');

const STATE_SECRET = 'test-state-secret';
const REDIRECT_URI = 'http://localhost:3009/api/oauth/shopee/callback';

function req(integracaoId?: string, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3009/api/marketplace/shopee/oauth/start');
  if (integracaoId !== undefined) url.searchParams.set('integracaoId', integracaoId);
  return new Request(url, { headers });
}

const WRITER = {
  uid: 'u1',
  permissions: (PERM.integracao.read | PERM.integracao.write).toString(),
};

/** What the real loader would resolve to, with the real host resolution. */
function ctxDouble() {
  return {
    integracaoId: 'int-1',
    config: {
      partnerId: 1234567,
      partnerKey: 'chave-de-teste',
      redirectUri: REDIRECT_URI,
      sandbox: true,
      hosts: {
        apiHost: 'https://api.example',
        authHost: SHOPEE_SANDBOX_AUTH_HOST,
        authorizeUrlBase: `${SHOPEE_SANDBOX_AUTH_HOST}/auth`,
        cancelAuthUrlBase: `${SHOPEE_SANDBOX_AUTH_HOST}/cancel_auth`,
      },
    },
  };
}

let spyErro: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SHOPEE_STATE_SECRET', STATE_SECRET);
  spyErro = vi.spyOn(console, 'error').mockImplementation(() => {});
  h.putOauthState.mockResolvedValue(undefined);
  h.loadCtx.mockResolvedValue(ctxDouble());
});

afterEach(() => {
  vi.unstubAllEnvs();
  spyErro.mockRestore();
});

describe('GET /api/marketplace/shopee/oauth/start', () => {
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

  it('returns 500 when SHOPEE_STATE_SECRET is blank', async () => {
    // Blank must behave as unset: without the HMAC key the callback has no
    // trust anchor at all, so refusing to mint is the only safe answer.
    h.verifyIdToken.mockResolvedValue(WRITER);
    vi.stubEnv('SHOPEE_STATE_SECRET', '   ');
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(500);
    expect(h.putOauthState).not.toHaveBeenCalled();
  });

  it('returns the Format A consent URL with a verifiable state', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);

    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe(`${SHOPEE_SANDBOX_AUTH_HOST}/auth`);
    expect(url.searchParams.get('partner_id')).toBe('1234567');
    expect(url.searchParams.get('auth_type')).toBe('seller');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');

    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(verifyState(state!, STATE_SECRET).id).toBe('int-1');
    expect(h.loadCtx).toHaveBeenCalledWith(expect.anything(), 'int-1');
  });

  it('is UNSIGNED — no timestamp and no sign on the consent URL', async () => {
    // The near miss the legacy Flutter app shipped: it built the obsolete
    // signed `/api/v2/shop/auth_partner?…&redirect=` link and omitted three
    // parameters `guide 20` marks Required.
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('timestamp')).toBeNull();
    expect(url.searchParams.get('sign')).toBeNull();
    expect(url.searchParams.get('redirect')).toBeNull();
    // …and the partner key never leaves the backend.
    expect(authorizeUrl).not.toContain('chave-de-teste');
  });

  it('records the attempt under the SAME nonce the state carries, with a null verifier', async () => {
    // The binding that makes the state single-use: if the persisted nonce and
    // the one inside the state ever diverge, the callback can never redeem a
    // legitimate attempt. `codeVerifier` is permanently null — Shopee has no PKCE.
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

  it('persists the attempt BEFORE the response is built (#821)', async () => {
    // A consent completed against a record that was never written is a connect
    // that fails closed. The order is the guarantee, so it is asserted.
    h.verifyIdToken.mockResolvedValue(WRITER);
    let liberarPut!: () => void;
    const putEmVoo = new Promise<void>((resolve) => {
      liberarPut = resolve;
    });
    let respondeu = false;
    h.putOauthState.mockImplementation(async () => putEmVoo);

    const pending = GET(req('int-1', { authorization: 'Bearer t' })).then((res) => {
      respondeu = true;
      return res;
    });

    // The route is now blocked inside `put`. Nothing may have answered yet.
    await vi.waitFor(() => {
      expect(h.putOauthState).toHaveBeenCalledTimes(1);
    });
    expect(respondeu).toBe(false);

    liberarPut();
    const res = await pending;
    expect(res.status).toBe(200);
  });

  it('answers 404 for a non-Shopee conta and never mints a state', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(404);
    expect(h.putOauthState).not.toHaveBeenCalled();
  });
});
