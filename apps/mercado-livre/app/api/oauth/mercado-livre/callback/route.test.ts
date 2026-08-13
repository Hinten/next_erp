import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  MercadoLivreError,
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  MercadoLivreValidationError,
} from '@delfrance/integrations-mercado-livre';

import {
  MercadoLivreConfigError,
  MercadoLivreContaNotConfiguredError,
} from '@/lib/marketplace/mercadoLivre';
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

let spyErro: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WEB_APP_URL', 'http://localhost:3000');
  vi.stubEnv('MERCADO_LIVRE_STATE_SECRET', STATE_SECRET);
  // Silenced as well as observed: without the mock body these tests would print
  // their deliberate failures into the suite output.
  spyErro = vi.spyOn(console, 'error').mockImplementation(() => {});
  h.exchangeAndPersist.mockResolvedValue(undefined);
  h.loadCtx.mockResolvedValue({ integracaoId: 'int-1', exchangeAndPersist: h.exchangeAndPersist });
  h.consumeOauthState.mockResolvedValue({ codeVerifier: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  spyErro.mockRestore();
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

  /**
   * Each of these used to redirect with the SAME `reason=exchange`, because
   * `isMercadoLivreError` matches five disjoint families and the route collapsed
   * them. A misconfigured backend was indistinguishable from an expired code —
   * from the browser and from the logs alike.
   *
   * `exchange` survives as the fallback for a guard member with no mapping, so an
   * unrecognised error still redirects rather than 500ing.
   */
  describe.each([
    ['server_config', () => new MercadoLivreConfigError('sem credenciais')],
    ['conta', () => new MercadoLivreContaNotConfiguredError('int-1')],
    [
      'codigo_invalido',
      () => new MercadoLivreReauthRequiredError('refresh_failed', 'code expirado', 400, {}),
    ],
    ['ml_rejeitou', () => new MercadoLivreHttpError('ML /oauth/token: nope', 400, {})],
    ['resposta_invalida', () => new MercadoLivreValidationError('formato inesperado', [])],
    ['rede', () => new MercadoLivreNetworkError('fetch falhou')],
    // Matched by the guard (the base class) but deliberately unmapped.
    ['exchange', () => new MercadoLivreError('algo novo')],
  ])('when the exchange fails with %s', (reason, makeError) => {
    it(`redirects to the account page with reason=${reason}`, async () => {
      h.exchangeAndPersist.mockRejectedValue(makeError());
      const res = await GET(
        req({ code: 'auth-code', state: signState('int-1', STATE_SECRET).state }),
      );

      const url = location(res);
      expect(url.pathname).toBe('/canais/mercado-livre/int-1');
      expect(url.searchParams.get('ml')).toBe('error');
      expect(url.searchParams.get('reason')).toBe(reason);
    });
  });

  it('logs the failure with the ML status, body and the computed redirect URI', async () => {
    // The ONLY record of an OAuth failure. Before this, the route swallowed the
    // error entirely: no status, no ML body, no redirect URI, nothing in Cloud
    // Logging — which is exactly what made a broken connect undiagnosable.
    const erro = new MercadoLivreHttpError('ML /oauth/token: invalid_client', 400, {
      error: 'invalid_client',
      message: 'invalid client_id or client_secret',
    });
    h.exchangeAndPersist.mockRejectedValue(erro);
    vi.stubEnv('MERCADO_LIVRE_PUBLIC_URL', 'https://ml.example.com');

    await GET(req({ code: 'auth-code', state: signState('int-1', STATE_SECRET).state }));

    expect(spyErro).toHaveBeenCalledTimes(1);
    const [msg, campos] = spyErro.mock.calls[0]!;
    expect(msg).toContain('[mercado-livre/oauth-callback]');
    expect(campos).toMatchObject({
      integracaoId: 'int-1',
      reason: 'ml_rejeitou',
      erro: 'MercadoLivreHttpError',
      status: 400,
      body: { error: 'invalid_client' },
      redirectUri: 'https://ml.example.com/api/oauth/mercado-livre/callback',
    });
  });

  it('names the failing fields when ML returns 200 with an unparseable body', async () => {
    // The real-world case this arm exists for: an aplicação without `offline_access`
    // gets a 200 with NO `refresh_token`, which tokenResponseSchema requires. Logging
    // only "formato inesperado" is true and useless — the field name IS the diagnosis.
    h.exchangeAndPersist.mockRejectedValue(
      new MercadoLivreValidationError('Resposta do /oauth/token em formato inesperado.', [
        { code: 'invalid_type', path: ['refresh_token'], message: 'Required' },
      ]),
    );
    await GET(req({ code: 'auth-code', state: signState('int-1', STATE_SECRET).state }));

    expect(spyErro.mock.calls[0]![1]).toMatchObject({
      reason: 'resposta_invalida',
      camposInvalidos: ['refresh_token: invalid_type'],
    });
  });

  it('survives a malformed issues array instead of turning the log into a 500', async () => {
    // `issues` is typed `unknown`. Destructuring a null entry throws a TypeError,
    // and it would throw INSIDE the catch block — replacing the redirect that
    // names the cause with an unhandled 500. The diagnostic must never be able to
    // cause a worse failure than the one it describes.
    h.exchangeAndPersist.mockRejectedValue(
      new MercadoLivreValidationError('formato inesperado', [
        null,
        'nem um objeto',
        { code: 'invalid_type', path: ['refresh_token'] },
      ]),
    );
    const res = await GET(
      req({ code: 'auth-code', state: signState('int-1', STATE_SECRET).state }),
    );

    // Still a redirect naming the cause — not a throw.
    expect(location(res).searchParams.get('reason')).toBe('resposta_invalida');
    expect(spyErro.mock.calls[0]![1]).toMatchObject({
      camposInvalidos: ['(desconhecido)', '(desconhecido)', 'refresh_token: invalid_type'],
    });
  });

  it('logs only issue paths and codes, never the offending token value', async () => {
    // Zod issues can carry the input under inspection, and here that input is a
    // TOKEN RESPONSE — passing the raw issues through would put a live access_token
    // into Cloud Logging.
    h.exchangeAndPersist.mockRejectedValue(
      new MercadoLivreValidationError('formato inesperado', [
        {
          code: 'invalid_type',
          path: ['access_token'],
          message: 'Required',
          input: 'APP_USR-um-token-de-verdade',
        },
      ]),
    );
    await GET(req({ code: 'auth-code', state: signState('int-1', STATE_SECRET).state }));

    expect(JSON.stringify(spyErro.mock.calls[0])).not.toContain('APP_USR-um-token-de-verdade');
  });

  it('never logs the authorization code', async () => {
    // `code` is a live credential until it is exchanged, and Cloud Logging is
    // broadly readable. A regression here leaks it to everyone with log access.
    h.exchangeAndPersist.mockRejectedValue(new MercadoLivreHttpError('nope', 400, {}));
    await GET(req({ code: 'super-secret-code', state: signState('int-1', STATE_SECRET).state }));

    expect(spyErro).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spyErro.mock.calls[0])).not.toContain('super-secret-code');
  });

  it('does not log anything on a successful connect', async () => {
    await GET(req({ code: 'auth-code', state: signState('int-1', STATE_SECRET).state }));
    expect(spyErro).not.toHaveBeenCalled();
  });
});
