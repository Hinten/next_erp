import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_PROD_AUTH_HOST,
  ShopeeNetworkError,
  ShopeeReauthRequiredError,
} from '@delfrance/integrations-shopee';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import {
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
} from '@/lib/shopee/core/tokenStore';
import { shopeeContaStatusSchema } from '@/lib/shopee/conta/status';

/**
 * Mocked: admin auth (drives `verifyCaller`), the Shopee context loader
 * (Firestore + the token store) and the partner client factory (network).
 * `findAuthorizedShop` stays REAL, so the paging walk and the seconds→ms
 * conversion are exercised by this route's tests too.
 *
 * ⚠️ The shop client comes from the CONTEXT now, not from the package factory:
 * `ctx.createShopClient()` is what carries the token store, and the double below
 * reproduces the one property this route depends on — the token is fetched
 * per call, INSIDE `getShopInfo`, so a renewal failure surfaces exactly where a
 * real one would.
 */
const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  readCredential: vi.fn(),
  getAccessToken: vi.fn(),
  createShopClient: vi.fn(),
  getShopsByPartner: vi.fn(),
  getShopInfo: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/shopee/core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

vi.mock('@delfrance/integrations-shopee', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-shopee')>();
  return {
    ...actual,
    createShopeePartnerClient: () => ({ getShopsByPartner: h.getShopsByPartner }),
  };
});

const { GET } = await import('./route');

const AGORA = Date.now();
const DIA_S = 24 * 60 * 60;
const HORA_MS = 60 * 60 * 1000;

/** A stored pair that outlives the refresh skew by hours. */
const CRED_VIVA = {
  access_token: 'at-1',
  refresh_token: 'rt-1',
  expirationDate: AGORA + 4 * HORA_MS,
};

/** The same pair, already stale — what a conta looks like before a renewal. */
const CRED_VENCIDA = { access_token: 'at-1', refresh_token: 'rt-1', expirationDate: AGORA - 1 };

function req(integracaoId?: string, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3009/api/marketplace/shopee/conta');
  if (integracaoId !== undefined) url.searchParams.set('integracaoId', integracaoId);
  return new Request(url, { headers });
}

const READER = { uid: 'u1', permissions: PERM.integracao.read.toString() };

function ctxDouble(conta: Record<string, unknown> = {}) {
  return {
    integracaoId: 'int-1',
    conta: { tipo: 5, shop_id: 111, main_account_id: null, ...conta },
    config: {
      partnerId: 1234567,
      partnerKey: 'chave-de-teste',
      redirectUri: 'http://localhost:3009/api/oauth/shopee/callback',
      sandbox: false,
      hosts: {
        apiHost: 'https://api.example',
        authHost: SHOPEE_PROD_AUTH_HOST,
        authorizeUrlBase: `${SHOPEE_PROD_AUTH_HOST}/auth`,
        cancelAuthUrlBase: `${SHOPEE_PROD_AUTH_HOST}/cancel_auth`,
      },
    },
    readCredential: h.readCredential,
    getAccessToken: h.getAccessToken,
    createShopClient: h.createShopClient,
    exchangeAndPersist: vi.fn(),
  };
}

function shopsPage(shopIds: readonly number[], more = false) {
  return {
    request_id: 'r',
    error: '',
    message: null,
    warning: null,
    authed_shop_list: shopIds.map((shop_id) => ({
      shop_id,
      auth_time: Math.floor(AGORA / 1000) - 10 * DIA_S,
      expire_time: Math.floor(AGORA / 1000) + 30 * DIA_S,
      region: 'BR',
      sip_affi_shop_list: null,
    })),
    more,
  };
}

/** A dead grant, as `getOrRefreshAccessToken` rethrows it out of the shop call. */
function reauthRequired(): ShopeeReauthRequiredError {
  return new ShopeeReauthRequiredError('autorização encerrada', {
    code: 'refresh_token_expired',
    kind: SHOPEE_ERROR_KIND.reauth,
    httpStatus: 200,
    path: '/api/v2/auth/access_token/get',
  });
}

let spyWarn: ReturnType<typeof vi.spyOn>;
let spyErro: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  spyErro = vi.spyOn(console, 'error').mockImplementation(() => {});
  h.verifyIdToken.mockResolvedValue(READER);
  h.loadCtx.mockResolvedValue(ctxDouble());
  h.getShopsByPartner.mockResolvedValue(shopsPage([111]));
  h.getShopInfo.mockResolvedValue({
    shop_name: 'Loja BR',
    region: 'BR',
    status: 'NORMAL',
    is_cb: false,
    auth_time: 1,
    expire_time: 2,
  });
  h.getAccessToken.mockResolvedValue('at-1');
  // The token is fetched INSIDE the call, exactly as `createShopeeClient` does
  // it: a renewal that fails takes `get_shop_info` down with it.
  h.createShopClient.mockImplementation(() => ({
    async getShopInfo() {
      await h.getAccessToken();
      return h.getShopInfo();
    },
  }));
  h.readCredential.mockResolvedValue(CRED_VIVA);
});

afterEach(() => {
  spyWarn.mockRestore();
  spyErro.mockRestore();
});

describe('GET /api/marketplace/shopee/conta — auth and arguments', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await GET(req('int-1'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a caller without integracao.read', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when integracaoId is missing', async () => {
    const res = await GET(req(undefined, { authorization: 'Bearer t' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 for a conta of another tipo', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(404);
  });
});

describe('the disconnected states are 200, not errors', () => {
  it('answers connected:false with ZERO provider calls when no credential is stored', async () => {
    // Rendering the disconnected state is the whole point of this route. And
    // nothing may reach the token store either: there is no pair to renew, so a
    // renewal attempt could only produce a 409 for a state that is not an error.
    h.readCredential.mockResolvedValue(null);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ connected: false, shopId: null });
    expect(h.getShopsByPartner).not.toHaveBeenCalled();
    expect(h.getShopInfo).not.toHaveBeenCalled();
    expect(h.createShopClient).not.toHaveBeenCalled();
    expect(h.getAccessToken).not.toHaveBeenCalled();
  });

  it('answers connected:false when the conta has no shop_id yet, without ever asking for a token', async () => {
    // A main-account-scoped consent stores a credential and denormalises only
    // `main_account_id`. `status.ts` documents `credencial: null` as "nothing
    // stored at all", so this branch must NOT answer null for a stored token —
    // the near-miss of the no-credential case above.
    //
    // ⚠️ And `getAccessToken` must not be reached: with no `shop_id` it can only
    // throw `ShopeeContaSemShopIdError`, turning a legitimate connected state
    // into a 409.
    h.loadCtx.mockResolvedValue(ctxDouble({ shop_id: null, main_account_id: 777 }));
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ connected: false, shopId: null, mainAccountId: 777 });
    expect(body.credencial).not.toBeNull();
    expect(body.credencial).toMatchObject({ expirada: expect.any(Boolean) });
    expect(h.getShopsByPartner).not.toHaveBeenCalled();
    expect(h.getShopInfo).not.toHaveBeenCalled();
    expect(h.createShopClient).not.toHaveBeenCalled();
    expect(h.getAccessToken).not.toHaveBeenCalled();
  });

  it('echoes shopId and the credential clock when the authorization was revoked', async () => {
    // `null` from the token-free oracle IS the revoked/expired verdict, and the
    // operator needs to see WHICH shop stopped answering.
    h.getShopsByPartner.mockResolvedValue(shopsPage([222]));
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ connected: false, shopId: 111 });
    expect(body.credencial).toMatchObject({ expirada: false });
    expect(h.getShopInfo).not.toHaveBeenCalled();
  });
});

describe('the two clocks', () => {
  it('reads the shop details even when the STORED access token had already expired', async () => {
    // The shop client takes its token from the store, so a stale stored pair is
    // renewed on the way in and the side read succeeds. Skipping it on a stale
    // stored expiry would skip the very call that repairs the pair.
    h.readCredential.mockResolvedValueOnce(CRED_VENCIDA).mockResolvedValueOnce(CRED_VIVA);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      connected: true,
      shopId: 111,
      loja: { shopName: 'Loja BR', region: 'BR', status: 'NORMAL' },
    });
    expect(body.diasParaExpirar).toBe(29);
    expect(h.getAccessToken).toHaveBeenCalledTimes(1);
    expect(h.getShopInfo).toHaveBeenCalledTimes(1);
  });

  it('reports credencial from the read taken AFTER the shop read', async () => {
    // Derived from the FIRST read this would say `expirada: true` next to a
    // populated `loja` — the panel would call the token dead while showing data
    // only a live one could have produced.
    h.readCredential.mockResolvedValueOnce(CRED_VENCIDA).mockResolvedValueOnce(CRED_VIVA);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.credencial).toMatchObject({
      expirada: false,
      expiraEm: CRED_VIVA.expirationDate,
      renovacaoFalhou: false,
    });
    expect(h.readCredential).toHaveBeenCalledTimes(2);
  });

  it('still reports expirada when the second read is stale too — the near-miss of the case above', async () => {
    // SAME first read, different second one, opposite verdict: the field tracks
    // the post-renewal document rather than being hardcoded off the shop read.
    h.readCredential.mockResolvedValue(CRED_VENCIDA);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.credencial).toMatchObject({
      expirada: true,
      expiraEm: CRED_VENCIDA.expirationDate,
    });
    expect(body).toMatchObject({ connected: true });
  });

  it('reads the shop details while the access token is live', async () => {
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      connected: true,
      shopId: 111,
      loja: { shopName: 'Loja BR', region: 'BR', status: 'NORMAL' },
    });
    expect(h.getShopInfo).toHaveBeenCalledTimes(1);
  });

  it('treats an UNCOMPARABLE stored expiry as expired, and still reads the shop', async () => {
    // `parseRead` is soft and returns the RAW document on a schema mismatch, so
    // `expirationDate` is not guaranteed to be a number. A comparison against
    // `undefined` answers `false` for reasons unrelated to freshness — and the
    // side read is attempted regardless, because the store decides freshness for
    // itself.
    h.readCredential.mockResolvedValue({
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expirationDate: '2026-01-01T00:00:00Z',
    });
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.credencial).toMatchObject({ expirada: true, expiraEm: 0 });
    expect(body).toMatchObject({ loja: { shopName: 'Loja BR' } });
  });
});

describe('get_shop_info is a SIDE read', () => {
  it('degrades to loja:null at 200 when it fails', async () => {
    // Losing the shop name must not cost the operator the authorization expiry,
    // which is the answer they actually came for.
    h.getShopInfo.mockRejectedValue(new ShopeeNetworkError('fetch falhou'));
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ connected: true, loja: null });
    expect(spyWarn).toHaveBeenCalledTimes(1);
  });

  it('degrades a renewal held by another instance, keeping both clocks intact', async () => {
    // `ShopeeRefreshEmAndamentoError` is a 503 everywhere else. Here it says
    // nothing about the conta: someone else holds the lease and the next request
    // finds the fresh pair.
    h.getAccessToken.mockRejectedValue(
      new ShopeeRefreshEmAndamentoError('renovação em andamento', AGORA + 30_000),
    );
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ connected: true, shopId: 111, loja: null });
    expect(body.expireTime).not.toBeNull();
    expect(body.diasParaExpirar).toBe(29);
    expect(body.credencial).toMatchObject({ renovacaoFalhou: false });
    expect(h.getShopInfo).not.toHaveBeenCalled();
  });

  it('degrades a DEAD GRANT to 200 and reports it through renovacaoFalhou', async () => {
    // A 409 here would throw away `expireTime` / `diasParaExpirar` — read
    // WITHOUT a token, and the authoritative statement about the authorization.
    // That is the legacy defect in mirror image, so the dead grant travels on
    // the credential block instead, next to both clocks.
    h.readCredential.mockResolvedValueOnce(CRED_VENCIDA).mockResolvedValueOnce({
      ...CRED_VENCIDA,
      ultimaFalhaRefresh: { em: AGORA, codigo: 'refresh_token_expired', terminal: true },
    });
    h.getAccessToken.mockRejectedValue(reauthRequired());
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(409);
    expect(res.status).not.toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ connected: true, shopId: 111, loja: null });
    expect(body.expireTime).not.toBeNull();
    expect(body.diasParaExpirar).toBe(29);
    expect(body.credencial).toMatchObject({ expirada: true, renovacaoFalhou: true });
  });

  it('degrades a credential that vanished between the two reads', async () => {
    // The operator disconnected the conta mid-request. The authorization clocks
    // were already read WITHOUT a token, so they are still worth answering.
    h.getAccessToken.mockRejectedValue(
      new ShopeeSemCredencialError('conta sem credencial utilizável'),
    );
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ connected: true, loja: null });
    expect(body.expireTime).not.toBeNull();
  });

  it('lets an unrelated failure surface instead of swallowing it (rule 6)', async () => {
    h.getShopInfo.mockRejectedValue(new TypeError('bug nosso'));
    await expect(GET(req('int-1', { authorization: 'Bearer t' }))).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe('renovacaoFalhou reads only a literal terminal:true', () => {
  it.each([
    ['a non-terminal stamp', { em: AGORA, codigo: 'error_rate_limit', terminal: false }],
    ['the STRING "true"', { em: AGORA, codigo: 'refresh_token_expired', terminal: 'true' }],
    ['a stamp that is not a map at all', 'refresh_token_expired'],
    ['no stamp', null],
  ])('answers false for %s', async (_caso, ultimaFalhaRefresh) => {
    // The wrong-way default is what matters: telling an operator to reconnect a
    // healthy conta costs a re-consent. `ultimaFalhaRefresh` is an unmodelled
    // `.passthrough()` key behind a SOFT `parseRead`, so no shape is guaranteed.
    h.readCredential.mockResolvedValue({ ...CRED_VIVA, ultimaFalhaRefresh });
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.credencial).toMatchObject({ renovacaoFalhou: false });
  });

  it('answers true for a literal terminal:true — the pair to the cases above', async () => {
    h.readCredential.mockResolvedValue({
      ...CRED_VIVA,
      ultimaFalhaRefresh: { em: AGORA, codigo: 'shop_access_expired', terminal: true },
    });
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.credencial).toMatchObject({ renovacaoFalhou: true });
  });
});

describe('the response contract', () => {
  it('parses against shopeeContaStatusSchema on the connected path', async () => {
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    const body = (await res.json()) as Record<string, unknown>;
    // The schema defaults `renovacaoFalhou`, so assert the route actually SENDS
    // it — otherwise the parse below would pass over a missing field.
    expect(body.credencial).toHaveProperty('renovacaoFalhou', false);
    expect(() => shopeeContaStatusSchema.parse(body)).not.toThrow();
  });

  it('parses against shopeeContaStatusSchema on the disconnected path', async () => {
    h.readCredential.mockResolvedValue(null);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    const body = await res.json();
    expect(() => shopeeContaStatusSchema.parse(body)).not.toThrow();
  });
});
