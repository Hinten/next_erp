import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  MelhorEnvioError,
  MelhorEnvioHttpError,
  MelhorEnvioNetworkError,
  MelhorEnvioReauthRequiredError,
  MelhorEnvioSchemaError,
} from '@delfrance/integrations-freight-br';

import {
  MelhorEnvioConfigError,
  MelhorEnvioContaNotConfiguredError,
} from '@/lib/freight/melhorEnvio';
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

let spyErro: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WEB_APP_URL', 'http://localhost:3000');
  vi.stubEnv('MELHOR_ENVIO_STATE_SECRET', STATE_SECRET);
  // Silenced as well as observed: without the mock body these tests would print
  // their deliberate failures into the suite output.
  spyErro = vi.spyOn(console, 'error').mockImplementation(() => {});
  h.exchangeAndPersist.mockResolvedValue({
    access_token: 'at',
    refresh_token: 'rt',
    expirationDate: 1,
  });
  h.loadCtx.mockResolvedValue({ intFreteId: 'int-1', exchangeAndPersist: h.exchangeAndPersist });
});

afterEach(() => {
  vi.unstubAllEnvs();
  spyErro.mockRestore();
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

  /**
   * All of these used to redirect with the SAME `reason=exchange`, because
   * `isMelhorEnvioError` matches seven families and the route collapsed them. A
   * backend missing its credentials was indistinguishable from an expired code.
   *
   * ⚠️ Two rows are ME-specific and would be WRONG if the Mercado Livre mapper were
   * copied verbatim: `codigo_invalido` has no dedicated class here (the package
   * never special-cases `invalid_grant`, so it must be read off the BODY), and the
   * bare base class is the `exchange` fallback rather than a network failure.
   */
  describe.each([
    ['server_config', () => new MelhorEnvioConfigError('sem credenciais')],
    ['conta', () => new MelhorEnvioContaNotConfiguredError('int-1')],
    [
      'codigo_invalido',
      () => new MelhorEnvioReauthRequiredError('refresh_failed', 'expirado', {}, 400),
    ],
    [
      // An expired/reused code as ME actually reports it: a plain HTTP error whose
      // BODY carries `invalid_grant`. `instanceof` alone would call this me_recusou.
      'codigo_invalido',
      () =>
        new MelhorEnvioHttpError('Melhor Envio /oauth/token: bad code', 400, {
          error: 'invalid_grant',
        }),
    ],
    ['me_recusou', () => new MelhorEnvioHttpError('Melhor Envio /oauth/token: HTTP 401', 401, {})],
    ['resposta_invalida', () => new MelhorEnvioSchemaError('formato inesperado', [], {})],
    ['rede', () => new MelhorEnvioNetworkError('fetch falhou')],
    // Matched by the guard (the base class) but deliberately unmapped.
    ['exchange', () => new MelhorEnvioError('algo novo')],
  ])('when the exchange fails with %s', (reason, makeError) => {
    it(`redirects to the account page with reason=${reason}`, async () => {
      h.exchangeAndPersist.mockRejectedValue(makeError());
      const res = await GET(req({ code: 'auth-code', state: signState('int-1', STATE_SECRET) }));

      const url = location(res);
      expect(url.pathname).toBe('/logistica/melhor-envios/int-1');
      expect(url.searchParams.get('me')).toBe('error');
      expect(url.searchParams.get('reason')).toBe(reason);
    });
  });

  it('logs the failure with the ME status, body and the computed redirect URI', async () => {
    // The ONLY record of an OAuth failure — this app logged nothing at all on this
    // path, so a broken connect left no server-side trace whatsoever.
    h.exchangeAndPersist.mockRejectedValue(
      new MelhorEnvioHttpError('Melhor Envio /oauth/token: invalid_client', 401, {
        error: 'invalid_client',
      }),
    );
    vi.stubEnv('MELHOR_ENVIO_PUBLIC_URL', 'https://me.example.com');

    await GET(req({ code: 'auth-code', state: signState('int-1', STATE_SECRET) }));

    expect(spyErro).toHaveBeenCalledTimes(1);
    const [msg, campos] = spyErro.mock.calls[0]!;
    expect(msg).toContain('[melhor-envio/oauth-callback]');
    expect(campos).toMatchObject({
      intFreteId: 'int-1',
      reason: 'me_recusou',
      erro: 'MelhorEnvioHttpError',
      status: 401,
      body: { error: 'invalid_client' },
      redirectUri: 'https://me.example.com/api/oauth/melhor-envio/callback',
    });
  });

  it('names the failing fields when ME returns 200 with an unparseable body', async () => {
    h.exchangeAndPersist.mockRejectedValue(
      new MelhorEnvioSchemaError(
        'formato inesperado',
        [{ code: 'invalid_type', path: ['refresh_token'], message: 'Required' }],
        { token_type: 'Bearer' },
      ),
    );
    await GET(req({ code: 'auth-code', state: signState('int-1', STATE_SECRET) }));

    expect(spyErro.mock.calls[0]![1]).toMatchObject({
      reason: 'resposta_invalida',
      camposInvalidos: ['refresh_token: invalid_type'],
    });
  });

  it('survives a malformed issues array instead of turning the log into a 500', async () => {
    // `issues` is typed `unknown`. Destructuring a null entry throws a TypeError,
    // and it would throw INSIDE the catch block — replacing the redirect that names
    // the cause with an unhandled 500.
    h.exchangeAndPersist.mockRejectedValue(
      new MelhorEnvioSchemaError(
        'formato inesperado',
        [null, 'nem um objeto', { code: 'invalid_type', path: ['refresh_token'] }],
        {},
      ),
    );
    const res = await GET(req({ code: 'auth-code', state: signState('int-1', STATE_SECRET) }));

    expect(location(res).searchParams.get('reason')).toBe('resposta_invalida');
    expect(spyErro.mock.calls[0]![1]).toMatchObject({
      camposInvalidos: ['(desconhecido)', '(desconhecido)', 'refresh_token: invalid_type'],
    });
  });

  it('never logs the token response body of a schema failure', async () => {
    // ⚠️ On a schema error the body IS the token response — a 200 that merely
    // lacked a required field still carries a live access_token. Only the FIELD
    // NAMES may be logged. (An HTTP error's body is safe by contrast: it is a
    // non-2xx error body, and the test above asserts it IS logged.)
    h.exchangeAndPersist.mockRejectedValue(
      new MelhorEnvioSchemaError(
        'formato inesperado',
        [{ code: 'invalid_type', path: ['refresh_token'], input: 'tok-do-corpo' }],
        { access_token: 'tok-do-corpo', token_type: 'Bearer' },
      ),
    );
    await GET(req({ code: 'auth-code', state: signState('int-1', STATE_SECRET) }));

    expect(JSON.stringify(spyErro.mock.calls[0])).not.toContain('tok-do-corpo');
  });

  it('never logs the authorization code', async () => {
    // `code` is a live credential until it is exchanged, and Cloud Logging is
    // broadly readable.
    h.exchangeAndPersist.mockRejectedValue(new MelhorEnvioHttpError('nope', 400, {}));
    await GET(req({ code: 'super-secret-code', state: signState('int-1', STATE_SECRET) }));

    expect(JSON.stringify(spyErro.mock.calls[0])).not.toContain('super-secret-code');
  });

  it('does not log anything on a successful connect', async () => {
    await GET(req({ code: 'auth-code', state: signState('int-1', STATE_SECRET) }));
    expect(spyErro).not.toHaveBeenCalled();
  });
});
