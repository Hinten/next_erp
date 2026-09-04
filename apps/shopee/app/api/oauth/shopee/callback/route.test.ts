import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';
import { OauthStateError, signState } from '@delfrance/data/admin/oauth-state';

import { ShopeeCredencialInvalidaError } from '@/lib/shopee/core/credentialStore';
import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';

/**
 * The callback takes NO Bearer token — it is a browser redirect from Shopee —
 * so the signed `state` plus its single-use record are the only trust anchors.
 * `signState` / `verifyState` stay REAL so the state genuinely round-trips; the
 * context loader (token exchange) and the Firestore-backed attempt store are
 * mocked, via `importActual` so the real error classes survive and
 * `isShopeeError` still narrows.
 */
const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
  exchangeAndPersist: vi.fn(),
  consumeOauthState: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/shopee/core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

vi.mock('@/lib/shopee/conta/oauthState', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/conta/oauthState')>();
  return {
    ...actual,
    shopeeOauthState: { ...actual.shopeeOauthState, consume: h.consumeOauthState },
  };
});

const { GET } = await import('./route');

const STATE_SECRET = 'callback-state-secret';

function req(params: Record<string, string>): Request {
  const url = new URL('http://localhost:3009/api/oauth/shopee/callback');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

/** The redirect target the browser is sent to. */
function location(res: Response): URL {
  const loc = res.headers.get('location');
  expect(loc).toBeTruthy();
  return new URL(loc!);
}

function apiError(code: string): ShopeeApiError {
  return new ShopeeApiError(`Shopee respondeu ${code}`, {
    code,
    kind: 'other',
    httpStatus: 200,
    path: '/api/v2/auth/token/get',
    requestId: 'req-1',
  });
}

let spyErro: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WEB_APP_URL', 'http://localhost:3000');
  vi.stubEnv('SHOPEE_STATE_SECRET', STATE_SECRET);
  vi.stubEnv('SHOPEE_PUBLIC_URL', '');
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

describe('GET /api/oauth/shopee/callback — the happy paths', () => {
  it('exchanges a shop_id consent and redirects with shopee=connected', async () => {
    const { state, nonce } = signState('int-1', STATE_SECRET);
    const res = await GET(req({ code: 'auth-code', state, shop_id: '111' }));

    const url = location(res);
    expect(url.pathname).toBe('/canais/shopee/int-1');
    expect(url.searchParams.get('shopee')).toBe('connected');
    expect(h.exchangeAndPersist).toHaveBeenCalledWith('auth-code', { kind: 'shop', shopId: 111 });
    // The attempt named by THIS state is what gets redeemed.
    expect(h.consumeOauthState).toHaveBeenCalledWith(expect.anything(), 'int-1', nonce);
  });

  it('exchanges a main_account_id consent under the other id class', async () => {
    // The two id classes are refreshed separately (step 2), so the subject the
    // callback builds decides which key the stored pair belongs to.
    const { state } = signState('int-1', STATE_SECRET);
    await GET(req({ code: 'auth-code', state, main_account_id: '999' }));
    expect(h.exchangeAndPersist).toHaveBeenCalledWith('auth-code', {
      kind: 'main_account',
      mainAccountId: 999,
    });
  });

  it('does not log anything on a successful connect', async () => {
    await GET(
      req({ code: 'auth-code', state: signState('int-1', STATE_SECRET).state, shop_id: '111' }),
    );
    expect(spyErro).not.toHaveBeenCalled();
  });
});

describe('the state is the only trust anchor', () => {
  it('redirects with reason=config when the state secret is blank', async () => {
    vi.stubEnv('SHOPEE_STATE_SECRET', '   ');
    const res = await GET(req({ code: 'c', state: 's', shop_id: '1' }));
    const url = location(res);
    expect(url.pathname).toBe('/canais/shopee');
    expect(url.searchParams.get('reason')).toBe('config');
  });

  it('FAILS CLOSED when the callback carries no state at all', async () => {
    // `guide 20` documents `state` as echoed "as-is" but its callback parameter
    // table lists only code / shop_id / main_account_id. Until a live round trip
    // settles that, a stateless callback is refused rather than trusted.
    const res = await GET(req({ code: 'c', shop_id: '111' }));
    const url = location(res);
    expect(url.pathname).toBe('/canais/shopee');
    expect(url.searchParams.get('reason')).toBe('bad_state');
    expect(h.consumeOauthState).not.toHaveBeenCalled();
    expect(h.exchangeAndPersist).not.toHaveBeenCalled();
  });

  it('redirects with reason=bad_state when the signature does not verify', async () => {
    const { state: forged } = signState('int-1', 'a-different-secret');
    const res = await GET(req({ code: 'c', state: forged, shop_id: '111' }));
    expect(location(res).searchParams.get('reason')).toBe('bad_state');
    expect(h.consumeOauthState).not.toHaveBeenCalled();
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('redirects with reason=bad_state on a REPLAY of an already-consumed attempt', async () => {
    // Verifying the HMAC proves integrity, not freshness-of-use: a captured
    // callback would otherwise stay replayable for the whole 10-minute window.
    h.consumeOauthState.mockRejectedValue(new OauthStateError('state já utilizado'));
    const { state } = signState('int-1', STATE_SECRET);
    const res = await GET(req({ code: 'c', state, shop_id: '111' }));

    expect(location(res).searchParams.get('reason')).toBe('bad_state');
    // Nothing touched the credential — the replay is rejected before the exchange.
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.exchangeAndPersist).not.toHaveBeenCalled();
  });
});

describe('the callback parameters', () => {
  it('answers missing_params on the ACCOUNT page without burning the attempt', async () => {
    // A cancelled consent arrives with a valid state and no code. Consuming the
    // single-use attempt there would force a restart from `oauth/start` for
    // nothing — there is no code to exchange either way.
    const { state } = signState('int-1', STATE_SECRET);
    const res = await GET(req({ state, shop_id: '111' }));

    const url = location(res);
    expect(url.pathname).toBe('/canais/shopee/int-1');
    expect(url.searchParams.get('reason')).toBe('missing_params');
    expect(h.consumeOauthState).not.toHaveBeenCalled();
  });

  it.each([
    ['neither id', {}],
    ['a non-numeric shop id', { shop_id: '111abc' }],
    ['a blank shop id', { shop_id: '' }],
    ['a negative shop id', { shop_id: '-5' }],
    ['a fractional main account id', { main_account_id: '99.5' }],
  ])('answers loja_invalida for %s', async (_label, extra) => {
    // `parseInt('111abc')` answers 111 and signs cleanly — the truncated id
    // either fails with error_sign or authorises the WRONG shop.
    const { state } = signState('int-1', STATE_SECRET);
    const res = await GET(req({ code: 'c', state, ...extra }));

    expect(location(res).searchParams.get('reason')).toBe('loja_invalida');
    expect(h.consumeOauthState).not.toHaveBeenCalled();
  });
});

/**
 * Each of these would collapse into one slug if the `instanceof` chain were
 * ordered base-first, which is the trap this table pins. `exchange` survives as
 * the fallback so an unrecognised member of the guard still redirects rather
 * than 500ing.
 */
describe.each([
  ['server_config', () => new ShopeeConfigError('SHOPEE_PARTNER_KEY não configurado')],
  ['conta', () => new ShopeeContaNotConfiguredError('int-1 não é do tipo Shopee')],
  ['codigo_invalido', () => apiError('invalid_code')],
  ['loja_invalida', () => apiError('invalid_shop_id')],
  // ⚠️ Shopee's own spelling, one `c` short of "account". Matched byte-for-byte.
  ['loja_invalida', () => apiError('invalid_main_acount_id')],
  ['shopee_rejeitou', () => apiError('error_param')],
  // A reauth subclass is still a ShopeeApiError with an unmapped code.
  [
    'shopee_rejeitou',
    () =>
      new ShopeeReauthRequiredError('autorização morta', {
        code: 'shop_access_expired',
        kind: 'reauth',
        httpStatus: 200,
        path: '/api/v2/auth/token/get',
      }),
  ],
  [
    'resposta_invalida',
    () =>
      new ShopeeSchemaError('formato inesperado', {
        campos: ['access_token'],
        httpStatus: 200,
        path: '/api/v2/auth/token/get',
      }),
  ],
  [
    'resposta_invalida',
    () => new ShopeeCredencialInvalidaError('credencial inválida', ['refresh_token']),
  ],
  ['rede', () => new ShopeeNetworkError('fetch falhou')],
  // Matched by the guard (the base class) but deliberately unmapped.
  ['exchange', () => new ShopeeError('algo novo')],
  // Also unmapped on purpose — an edge rejection has no slug apps/web renders.
  [
    'exchange',
    () => new ShopeeHttpError('403 na borda', { httpStatus: 403, path: '/api/v2/auth/token/get' }),
  ],
])('when the exchange fails and the slug must be %s', (reason, makeError) => {
  it(`redirects to the account page with reason=${reason}`, async () => {
    h.exchangeAndPersist.mockRejectedValue(makeError());
    const res = await GET(
      req({ code: 'auth-code', state: signState('int-1', STATE_SECRET).state, shop_id: '111' }),
    );

    const url = location(res);
    expect(url.pathname).toBe('/canais/shopee/int-1');
    expect(url.searchParams.get('shopee')).toBe('error');
    expect(url.searchParams.get('reason')).toBe(reason);
  });
});

describe('the ordering pin', () => {
  it('does NOT collapse a schema or network failure into shopee_rejeitou', async () => {
    // `ShopeeSchemaError` and `ShopeeNetworkError` extend `ShopeeError`
    // DIRECTLY, not `ShopeeApiError`. If either ever gained `ShopeeApiError` as
    // a parent, the code lookup above would swallow it silently.
    expect(new ShopeeSchemaError('x', { httpStatus: 200, path: '/p' })).not.toBeInstanceOf(
      ShopeeApiError,
    );
    expect(new ShopeeNetworkError('x')).not.toBeInstanceOf(ShopeeApiError);
  });
});

describe('log hygiene', () => {
  it('never logs the authorization code', async () => {
    // `code` is a live credential until it is exchanged, and Cloud Logging is
    // broadly readable.
    h.exchangeAndPersist.mockRejectedValue(apiError('invalid_code'));
    await GET(
      req({
        code: 'super-secret-code',
        state: signState('int-1', STATE_SECRET).state,
        shop_id: '111',
      }),
    );

    expect(spyErro).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spyErro.mock.calls[0])).not.toContain('super-secret-code');
  });

  it('carries the fields that make a failure diagnosable', async () => {
    vi.stubEnv('SHOPEE_PUBLIC_URL', 'https://shopee.example.com');
    h.exchangeAndPersist.mockRejectedValue(apiError('invalid_code'));
    await GET(
      req({ code: 'auth-code', state: signState('int-1', STATE_SECRET).state, shop_id: '111' }),
    );

    const [msg, campos] = spyErro.mock.calls[0]!;
    expect(msg).toContain('[shopee/oauth-callback]');
    expect(campos).toMatchObject({
      integracaoId: 'int-1',
      reason: 'codigo_invalido',
      erro: 'ShopeeApiError',
      status: 200,
      code: 'invalid_code',
      requestId: 'req-1',
      redirectUri: 'https://shopee.example.com/api/oauth/shopee/callback',
    });
  });

  it('logs the failing FIELD names on a schema error, never the body', async () => {
    // ⚠️ The body behind a token-endpoint schema failure IS the credential
    // (#1015). `campos` is paths only, and there is no `body` field at all.
    h.exchangeAndPersist.mockRejectedValue(
      new ShopeeSchemaError('formato inesperado', {
        campos: ['refresh_token'],
        httpStatus: 200,
        path: '/api/v2/auth/token/get',
      }),
    );
    await GET(
      req({ code: 'auth-code', state: signState('int-1', STATE_SECRET).state, shop_id: '111' }),
    );

    const campos = spyErro.mock.calls[0]![1] as Record<string, unknown>;
    expect(campos).toMatchObject({
      reason: 'resposta_invalida',
      camposInvalidos: ['refresh_token'],
    });
    expect(campos).not.toHaveProperty('body');
  });

  it('survives a malformed campos array instead of turning the log into a 500', async () => {
    // The diagnostic must never be able to cause a worse failure than the one
    // it describes: this runs INSIDE the catch block.
    h.exchangeAndPersist.mockRejectedValue(
      new ShopeeSchemaError('formato inesperado', {
        campos: ['refresh_token', 'texto em prosa que não é um caminho'],
        httpStatus: 200,
        path: '/api/v2/auth/token/get',
      }),
    );
    const res = await GET(
      req({ code: 'auth-code', state: signState('int-1', STATE_SECRET).state, shop_id: '111' }),
    );

    expect(location(res).searchParams.get('reason')).toBe('resposta_invalida');
    expect(spyErro.mock.calls[0]![1]).toMatchObject({
      camposInvalidos: ['refresh_token', '(desconhecido)'],
    });
  });
});
