import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  MercadoPagoError,
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
  MercadoPagoValidationError,
} from '@delfrance/integrations-mercado-pago';

import {
  MercadoPagoConfigError,
  MercadoPagoContaNotConfiguredError,
} from '@/lib/payments/mercadoPago';
import { signState } from '@/lib/payments/state';

// The callback takes NO Bearer token — it's a browser redirect from Mercado
// Pago — so the signed `state` is the only trust anchor. signState / verifyState
// stay real; only the MP context loader (token exchange) is mocked. The real
// error classes are kept via importActual so `isMercadoPagoError` still narrows.
const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
  exchangeAndPersist: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/payments/mercadoPago', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/payments/mercadoPago')>();
  return { ...actual, loadMercadoPagoContext: h.loadCtx };
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

let spyErro: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WEB_APP_URL', 'http://localhost:3000');
  vi.stubEnv('MERCADO_PAGO_STATE_SECRET', STATE_SECRET);
  // Silenced as well as observed: without the mock body these tests would print
  // their deliberate failures into the suite output.
  spyErro = vi.spyOn(console, 'error').mockImplementation(() => {});
  h.exchangeAndPersist.mockResolvedValue(undefined);
  h.loadCtx.mockResolvedValue({ metodoId: 'm1', exchangeAndPersist: h.exchangeAndPersist });
});

afterEach(() => {
  vi.unstubAllEnvs();
  spyErro.mockRestore();
});

describe('GET /api/oauth/mercado-pago/callback', () => {
  it('exchanges the code and redirects with mp=connected on a valid signed state', async () => {
    const state = signState('m1', STATE_SECRET);
    const res = await GET(req({ code: 'auth-code', state }));

    const url = location(res);
    expect(url.pathname).toBe('/pagamentos/mercado-pago/m1');
    expect(url.searchParams.get('mp')).toBe('connected');
    expect(h.exchangeAndPersist).toHaveBeenCalledWith('auth-code');
  });

  it('redirects with reason=missing_params when code or state is absent', async () => {
    const res = await GET(req({ state: signState('m1', STATE_SECRET) }));
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
    const forged = signState('m1', 'a-different-secret');
    const res = await GET(req({ code: 'c', state: forged }));
    const url = location(res);
    expect(url.searchParams.get('mp')).toBe('error');
    expect(url.searchParams.get('reason')).toBe('bad_state');
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  /**
   * All of these used to redirect with the SAME `reason=exchange`, because
   * `isMercadoPagoError` matches seven families and the route collapsed them. A
   * backend missing its credentials was indistinguishable from an expired code.
   *
   * ⚠️ Order is load-bearing: `MercadoPagoError` is the base of the plugin
   * hierarchy, so the last row must stay LAST or it would swallow the rest.
   */
  describe.each([
    ['server_config', () => new MercadoPagoConfigError('sem credenciais')],
    ['conta', () => new MercadoPagoContaNotConfiguredError('m1')],
    [
      'codigo_invalido',
      () => new MercadoPagoReauthRequiredError('refresh_failed', 'code expirado', 400, {}),
    ],
    ['mp_recusou', () => new MercadoPagoHttpError('MP /oauth/token: nope', 400, {})],
    ['resposta_invalida', () => new MercadoPagoValidationError('formato inesperado', [])],
    ['rede', () => new MercadoPagoNetworkError('fetch falhou')],
    // Matched by the guard (the base class) but deliberately unmapped.
    ['exchange', () => new MercadoPagoError('algo novo')],
  ])('when the exchange fails with %s', (reason, makeError) => {
    it(`redirects to the account page with reason=${reason}`, async () => {
      h.exchangeAndPersist.mockRejectedValue(makeError());
      const res = await GET(req({ code: 'auth-code', state: signState('m1', STATE_SECRET) }));

      const url = location(res);
      expect(url.pathname).toBe('/pagamentos/mercado-pago/m1');
      expect(url.searchParams.get('mp')).toBe('error');
      expect(url.searchParams.get('reason')).toBe(reason);
    });
  });

  it('logs the failure with the MP status, body and the computed redirect URI', async () => {
    // The ONLY record of an OAuth failure — this app logged nothing at all on this
    // path, so a broken connect left no server-side trace whatsoever.
    h.exchangeAndPersist.mockRejectedValue(
      new MercadoPagoHttpError('MP /oauth/token: invalid_client', 400, {
        error: 'invalid_client',
      }),
    );
    vi.stubEnv('MERCADO_PAGO_PUBLIC_URL', 'https://mp.example.com');

    await GET(req({ code: 'auth-code', state: signState('m1', STATE_SECRET) }));

    expect(spyErro).toHaveBeenCalledTimes(1);
    const [msg, campos] = spyErro.mock.calls[0]!;
    expect(msg).toContain('[mercado-pago/oauth-callback]');
    expect(campos).toMatchObject({
      metodoId: 'm1',
      reason: 'mp_recusou',
      erro: 'MercadoPagoHttpError',
      status: 400,
      body: { error: 'invalid_client' },
      redirectUri: 'https://mp.example.com/api/oauth/mercado-pago/callback',
    });
  });

  it('names the failing fields when MP returns 200 with an unparseable body', async () => {
    // MP's consent URL sends no `scope`, so whether a refresh_token comes back is
    // purely a property of the registered application — the field name is the only
    // clue the operator gets. Same trap that bit Mercado Livre in #1017.
    h.exchangeAndPersist.mockRejectedValue(
      new MercadoPagoValidationError('formato inesperado', [
        { code: 'invalid_type', path: ['refresh_token'], message: 'Required' },
      ]),
    );
    await GET(req({ code: 'auth-code', state: signState('m1', STATE_SECRET) }));

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
      new MercadoPagoValidationError('formato inesperado', [
        null,
        'nem um objeto',
        { code: 'invalid_type', path: ['refresh_token'] },
      ]),
    );
    const res = await GET(req({ code: 'auth-code', state: signState('m1', STATE_SECRET) }));

    expect(location(res).searchParams.get('reason')).toBe('resposta_invalida');
    expect(spyErro.mock.calls[0]![1]).toMatchObject({
      camposInvalidos: ['(desconhecido)', '(desconhecido)', 'refresh_token: invalid_type'],
    });
  });

  it('logs only issue paths and codes, never the offending token value', async () => {
    // ⚠️ A Zod issue can carry the input under inspection, and on this path that
    // input is a TOKEN RESPONSE.
    h.exchangeAndPersist.mockRejectedValue(
      new MercadoPagoValidationError('formato inesperado', [
        {
          code: 'invalid_type',
          path: ['access_token'],
          message: 'Required',
          input: 'APP_USR-um-token-de-verdade',
        },
      ]),
    );
    await GET(req({ code: 'auth-code', state: signState('m1', STATE_SECRET) }));

    expect(JSON.stringify(spyErro.mock.calls[0])).not.toContain('APP_USR-um-token-de-verdade');
  });

  it('never logs the authorization code', async () => {
    // `code` is a live credential until it is exchanged, and Cloud Logging is
    // broadly readable.
    h.exchangeAndPersist.mockRejectedValue(new MercadoPagoHttpError('nope', 400, {}));
    await GET(req({ code: 'super-secret-code', state: signState('m1', STATE_SECRET) }));

    expect(JSON.stringify(spyErro.mock.calls[0])).not.toContain('super-secret-code');
  });

  it('does not log anything on a successful connect', async () => {
    await GET(req({ code: 'auth-code', state: signState('m1', STATE_SECRET) }));
    expect(spyErro).not.toHaveBeenCalled();
  });
});
