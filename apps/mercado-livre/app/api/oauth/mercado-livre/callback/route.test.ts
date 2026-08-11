import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

import { MarketplaceStateError, signState } from '@/lib/marketplace/state';

// The callback takes NO Bearer token — it's a browser redirect from Mercado
// Livre — so the signed `state` plus its single-use record are the only trust
// anchors. signState / verifyState stay real; the ML context loader (token
// exchange) and the Firestore-backed attempt store are mocked. The real error
// classes are kept via importActual so `isMercadoLivreError` still narrows.
const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
  exchangeAndPersist: vi.fn(),
  consumeOauthState: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/marketplace/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@/lib/marketplace/oauthStateStore', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/oauthStateStore')>();
  return { ...actual, consumeOauthState: h.consumeOauthState };
});

const { GET } = await import('./route');

const STATE_SECRET = 'callback-state-secret';

function req(params: Record<string, string>): Request {
  const url = new URL('http://localhost:3006/api/oauth/mercado-livre/callback');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

/** The redirect target the browser is sent to. */
function location(res: Response): URL {
  const loc = res.headers.get('location');
  expect(loc).toBeTruthy();
  return new URL(loc!);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WEB_APP_URL', 'http://localhost:3000');
  vi.stubEnv('MERCADO_LIVRE_STATE_SECRET', STATE_SECRET);
  h.exchangeAndPersist.mockResolvedValue(undefined);
  h.loadCtx.mockResolvedValue({ integracaoId: 'int-1', exchangeAndPersist: h.exchangeAndPersist });
  h.consumeOauthState.mockResolvedValue({ codeVerifier: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/oauth/mercado-livre/callback', () => {
  it('exchanges the code and redirects with ml=connected on a valid signed state', async () => {
    const { state, nonce } = signState('int-1', STATE_SECRET);
    const res = await GET(req({ code: 'auth-code', state }));

    const url = location(res);
    expect(url.pathname).toBe('/canais/mercado-livre/int-1');
    expect(url.searchParams.get('ml')).toBe('connected');
    expect(h.exchangeAndPersist).toHaveBeenCalledWith('auth-code', undefined);
    // The attempt named by THIS state is what gets redeemed.
    expect(h.consumeOauthState).toHaveBeenCalledWith(expect.anything(), 'int-1', nonce);
  });

  it('forwards the stored PKCE verifier to the exchange', async () => {
    h.consumeOauthState.mockResolvedValue({ codeVerifier: 'the-verifier' });
    const { state } = signState('int-1', STATE_SECRET);
    await GET(req({ code: 'auth-code', state }));

    expect(h.exchangeAndPersist).toHaveBeenCalledWith('auth-code', 'the-verifier');
  });

  it('redirects with reason=bad_state when the attempt was already consumed (replay)', async () => {
    // #821/T3, the whole point: a state that verifies is not thereby unused.
    // Replaying a captured callback used to overwrite the account credential.
    h.consumeOauthState.mockRejectedValue(new MarketplaceStateError('state já utilizado'));
    const { state } = signState('int-1', STATE_SECRET);
    const res = await GET(req({ code: 'auth-code', state }));

    const url = location(res);
    expect(url.searchParams.get('ml')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('bad_state');
    // Nothing touched the credential — the replay is rejected before the exchange.
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.exchangeAndPersist).not.toHaveBeenCalled();
  });

  it('redirects with reason=missing_params when code or state is absent', async () => {
    const res = await GET(req({ state: signState('int-1', STATE_SECRET).state }));
    const url = location(res);
    expect(url.searchParams.get('ml')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('missing_params');
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.consumeOauthState).not.toHaveBeenCalled();
  });

  it('redirects with reason=config when the state secret is not configured', async () => {
    vi.stubEnv('MERCADO_LIVRE_STATE_SECRET', '');
    const res = await GET(req({ code: 'c', state: 's' }));
    const url = location(res);
    expect(url.searchParams.get('ml')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('config');
  });

  it('redirects with reason=bad_state when the state signature does not verify', async () => {
    const { state: forged } = signState('int-1', 'a-different-secret');
    const res = await GET(req({ code: 'c', state: forged }));
    const url = location(res);
    expect(url.searchParams.get('ml')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('bad_state');
    expect(h.loadCtx).not.toHaveBeenCalled();
    // A forged signature never reaches the store.
    expect(h.consumeOauthState).not.toHaveBeenCalled();
  });

  it('redirects with reason=exchange when the token exchange fails', async () => {
    h.exchangeAndPersist.mockRejectedValue(
      new MercadoLivreHttpError('ML /oauth/token: upstream error', 502, {}),
    );
    const { state } = signState('int-1', STATE_SECRET);
    const res = await GET(req({ code: 'auth-code', state }));

    const url = location(res);
    expect(url.pathname).toBe('/canais/mercado-livre/int-1');
    expect(url.searchParams.get('ml')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('exchange');
  });
});
