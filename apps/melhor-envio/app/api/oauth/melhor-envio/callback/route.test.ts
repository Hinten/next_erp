import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MelhorEnvioHttpError } from '@delfrance/integrations-freight-br';

import { signState } from '@/lib/freight/state';

// The callback takes NO Bearer token — it's a browser redirect from Melhor
// Envio — so the signed `state` is the only trust anchor. signState /
// verifyState stay real; only the ME context loader (token exchange) is mocked.
const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
  exchangeAndPersist: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/freight/melhorEnvio', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/freight/melhorEnvio')>();
  return { ...actual, loadMelhorEnvioContext: h.loadCtx };
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
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/oauth/melhor-envio/callback', () => {
  it('exchanges the code and redirects with me=connected on a valid signed state', async () => {
    const state = signState('int-1', STATE_SECRET);
    const res = await GET(req({ code: 'auth-code', state }));

    const url = location(res);
    expect(url.pathname).toBe('/logistica/melhor-envios/int-1');
    expect(url.searchParams.get('me')).toBe('connected');
    expect(h.exchangeAndPersist).toHaveBeenCalledWith('auth-code');
  });

  it('redirects with reason=missing_params when code or state is absent', async () => {
    const res = await GET(req({ state: signState('int-1', STATE_SECRET) }));
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
    const forged = signState('int-1', 'a-different-secret');
    const res = await GET(req({ code: 'c', state: forged }));
    const url = location(res);
    expect(url.searchParams.get('me')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('bad_state');
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('redirects with reason=exchange when the token exchange fails', async () => {
    h.exchangeAndPersist.mockRejectedValue(
      new MelhorEnvioHttpError('Melhor Envio /oauth/token: HTTP 400', 400, {}),
    );
    const state = signState('int-1', STATE_SECRET);
    const res = await GET(req({ code: 'auth-code', state }));

    const url = location(res);
    expect(url.pathname).toBe('/logistica/melhor-envios/int-1');
    expect(url.searchParams.get('me')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('exchange');
  });
});
