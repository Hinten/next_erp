import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoPagoHttpError } from '@delfrance/integrations-mercado-pago';

import { PaymentStateError, signState } from '@/lib/payments/state';

// The callback takes NO Bearer token — it's a browser redirect from Mercado
// Pago — so the signed `state` plus its single-use record are the only trust
// anchors. signState / verifyState stay real; the MP context loader (token
// exchange) and the Firestore-backed attempt store are mocked. The real error
// classes are kept via importActual so `isMercadoPagoError` still narrows.
const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
  exchangeAndPersist: vi.fn(),
  consumeOauthState: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/payments/mercadoPago', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/payments/mercadoPago')>();
  return { ...actual, loadMercadoPagoContext: h.loadCtx };
});

vi.mock('@/lib/payments/oauthState', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/payments/oauthState')>();
  return {
    ...actual,
    mercadoPagoOauthState: { ...actual.mercadoPagoOauthState, consume: h.consumeOauthState },
  };
});

const { GET } = await import('./route');

const STATE_SECRET = 'callback-state-secret';

function req(params: Record<string, string>): Request {
  const url = new URL('http://localhost:3007/api/oauth/mercado-pago/callback');
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
  vi.stubEnv('MERCADO_PAGO_STATE_SECRET', STATE_SECRET);
  h.exchangeAndPersist.mockResolvedValue(undefined);
  h.loadCtx.mockResolvedValue({ metodoId: 'm1', exchangeAndPersist: h.exchangeAndPersist });
  h.consumeOauthState.mockResolvedValue({ codeVerifier: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/oauth/mercado-pago/callback', () => {
  it('exchanges the code and redirects with mp=connected on a valid signed state', async () => {
    const { state, nonce } = signState('m1', STATE_SECRET);
    const res = await GET(req({ code: 'auth-code', state }));

    const url = location(res);
    expect(url.pathname).toBe('/pagamentos/mercado-pago/m1');
    expect(url.searchParams.get('mp')).toBe('connected');
    expect(h.exchangeAndPersist).toHaveBeenCalledWith('auth-code', undefined);
    // The attempt named by THIS state is what gets redeemed.
    expect(h.consumeOauthState).toHaveBeenCalledWith(expect.anything(), 'm1', nonce);
  });

  it('forwards the stored PKCE verifier to the exchange', async () => {
    h.consumeOauthState.mockResolvedValue({ codeVerifier: 'the-verifier' });
    const { state } = signState('m1', STATE_SECRET);
    await GET(req({ code: 'auth-code', state }));

    expect(h.exchangeAndPersist).toHaveBeenCalledWith('auth-code', 'the-verifier');
  });

  it('redirects with reason=bad_state when the attempt was already consumed (replay)', async () => {
    // #1034, the whole point: a state that verifies is not thereby unused.
    // Replaying a captured callback used to repoint the account at the
    // attacker's MP collector — after which CUSTOMER PAYMENTS land there.
    h.consumeOauthState.mockRejectedValue(new PaymentStateError('state já utilizado'));
    const { state } = signState('m1', STATE_SECRET);
    const res = await GET(req({ code: 'auth-code', state }));

    const url = location(res);
    expect(url.searchParams.get('mp')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('bad_state');
    // Nothing touched the credential — the replay is rejected before the exchange.
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.exchangeAndPersist).not.toHaveBeenCalled();
  });

  it('redirects with reason=missing_params when code or state is absent', async () => {
    const res = await GET(req({ state: signState('m1', STATE_SECRET).state }));
    const url = location(res);
    expect(url.searchParams.get('mp')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('missing_params');
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('redirects with reason=config when the state secret is not configured', async () => {
    vi.stubEnv('MERCADO_PAGO_STATE_SECRET', '');
    const res = await GET(req({ code: 'c', state: 's' }));
    const url = location(res);
    expect(url.searchParams.get('mp')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('config');
  });

  it('redirects with reason=bad_state when the state signature does not verify', async () => {
    const { state: forged } = signState('m1', 'a-different-secret');
    const res = await GET(req({ code: 'c', state: forged }));
    const url = location(res);
    expect(url.searchParams.get('mp')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('bad_state');
    expect(h.loadCtx).not.toHaveBeenCalled();
    // A forged signature never reaches the store.
    expect(h.consumeOauthState).not.toHaveBeenCalled();
  });

  it('redirects with reason=exchange when the token exchange fails', async () => {
    h.exchangeAndPersist.mockRejectedValue(
      new MercadoPagoHttpError('MP /oauth/token: upstream error', 502, {}),
    );
    const { state } = signState('m1', STATE_SECRET);
    const res = await GET(req({ code: 'auth-code', state }));

    const url = location(res);
    expect(url.pathname).toBe('/pagamentos/mercado-pago/m1');
    expect(url.searchParams.get('mp')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('exchange');
  });
});
