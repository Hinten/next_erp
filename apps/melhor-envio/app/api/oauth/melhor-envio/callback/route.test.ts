import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MelhorEnvioHttpError } from '@delfrance/integrations-freight-br';

import { FreightStateError, signState } from '@/lib/freight/state';

// The callback takes NO Bearer token — it's a browser redirect from Melhor
// Envio — so the signed `state` is the only trust anchor. signState /
// verifyState stay real; only the ME context loader (token exchange) is mocked.
const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
  exchangeAndPersist: vi.fn(),
  consumeOauthState: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/freight/melhorEnvio', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/freight/melhorEnvio')>();
  return { ...actual, loadMelhorEnvioContext: h.loadCtx };
});

vi.mock('@/lib/freight/oauthState', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/freight/oauthState')>();
  return {
    ...actual,
    melhorEnvioOauthState: { ...actual.melhorEnvioOauthState, consume: h.consumeOauthState },
  };
});

const { GET } = await import('./route');

const STATE_SECRET = 'callback-state-secret';

function req(params: Record<string, string>): Request {
  const url = new URL('http://localhost:3001/api/oauth/melhor-envio/callback');
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
  vi.stubEnv('MELHOR_ENVIO_STATE_SECRET', STATE_SECRET);
  h.exchangeAndPersist.mockResolvedValue({
    access_token: 'at',
    refresh_token: 'rt',
    expirationDate: 1,
  });
  h.loadCtx.mockResolvedValue({ intFreteId: 'int-1', exchangeAndPersist: h.exchangeAndPersist });
  h.consumeOauthState.mockResolvedValue({ codeVerifier: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/oauth/melhor-envio/callback', () => {
  it('exchanges the code and redirects with me=connected on a valid signed state', async () => {
    const { state, nonce } = signState('int-1', STATE_SECRET);
    const res = await GET(req({ code: 'auth-code', state }));

    const url = location(res);
    expect(url.pathname).toBe('/logistica/melhor-envios/int-1');
    expect(url.searchParams.get('me')).toBe('connected');
    expect(h.exchangeAndPersist).toHaveBeenCalledWith('auth-code');
    // The attempt named by THIS state is what gets redeemed.
    expect(h.consumeOauthState).toHaveBeenCalledWith(expect.anything(), 'int-1', nonce);
  });

  it('redirects with reason=bad_state when the attempt was already consumed (replay)', async () => {
    // #1034, the whole point: a state that verifies is not thereby unused.
    // Replaying a captured callback used to overwrite the account's ME token —
    // after which every label is bought against, and billed to, a stranger's
    // Melhor Envio account.
    h.consumeOauthState.mockRejectedValue(new FreightStateError('state já utilizado'));
    const { state } = signState('int-1', STATE_SECRET);
    const res = await GET(req({ code: 'auth-code', state }));

    const url = location(res);
    expect(url.searchParams.get('me')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('bad_state');
    // Nothing touched the credential — the replay is rejected before the exchange.
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.exchangeAndPersist).not.toHaveBeenCalled();
  });

  it('redirects with reason=missing_params when code or state is absent', async () => {
    const res = await GET(req({ state: signState('int-1', STATE_SECRET).state }));
    const url = location(res);
    expect(url.searchParams.get('me')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('missing_params');
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('redirects with reason=config when the state secret is not configured', async () => {
    vi.stubEnv('MELHOR_ENVIO_STATE_SECRET', '');
    const res = await GET(req({ code: 'c', state: 's' }));
    const url = location(res);
    expect(url.searchParams.get('me')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('config');
  });

  it('redirects with reason=bad_state when the state signature does not verify', async () => {
    const { state: forged } = signState('int-1', 'a-different-secret');
    const res = await GET(req({ code: 'c', state: forged }));
    const url = location(res);
    expect(url.searchParams.get('me')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('bad_state');
    expect(h.loadCtx).not.toHaveBeenCalled();
    // A forged signature never reaches the store.
    expect(h.consumeOauthState).not.toHaveBeenCalled();
  });

  it('redirects with reason=exchange when the token exchange fails', async () => {
    h.exchangeAndPersist.mockRejectedValue(
      new MelhorEnvioHttpError('Melhor Envio /oauth/token: HTTP 400', 400, {}),
    );
    const { state } = signState('int-1', STATE_SECRET);
    const res = await GET(req({ code: 'auth-code', state }));

    const url = location(res);
    expect(url.pathname).toBe('/logistica/melhor-envios/int-1');
    expect(url.searchParams.get('me')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('exchange');
  });
});
