import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { ShopeeNetworkError, SHOPEE_PROD_AUTH_HOST } from '@delfrance/integrations-shopee';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { shopeeContaStatusSchema } from '@/lib/shopee/conta/status';

/**
 * Mocked: admin auth (drives `verifyCaller`), the Shopee context loader
 * (Firestore) and the two package client factories (network). `findAuthorizedShop`
 * stays REAL, so the paging walk and the seconds→ms conversion are exercised by
 * this route's tests too.
 */
const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  readCredential: vi.fn(),
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
    createShopeeClient: () => ({ getShopInfo: h.getShopInfo, getProfile: vi.fn() }),
  };
});

const { GET } = await import('./route');

const AGORA = Date.now();
const DIA_S = 24 * 60 * 60;

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
  // A live access token by default: expires an hour from now.
  h.readCredential.mockResolvedValue({
    access_token: 'at-fake',
    refresh_token: 'rt-fake',
    expirationDate: AGORA + 60 * 60 * 1000,
  });
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
    // Rendering the disconnected state is the whole point of this route.
    h.readCredential.mockResolvedValue(null);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ connected: false, shopId: null });
    expect(h.getShopsByPartner).not.toHaveBeenCalled();
    expect(h.getShopInfo).not.toHaveBeenCalled();
  });

  it('answers connected:false when the conta has no shop_id yet, still echoing the credential clock', async () => {
    // A main-account-scoped consent stores a credential and denormalises only
    // `main_account_id`. `status.ts` documents `credencial: null` as "nothing
    // stored at all", so this branch must NOT answer null for a stored token —
    // the near-miss of the no-credential case above.
    h.loadCtx.mockResolvedValue(ctxDouble({ shop_id: null, main_account_id: 777 }));
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ connected: false, shopId: null, mainAccountId: 777 });
    expect(body.credencial).not.toBeNull();
    expect(body.credencial).toMatchObject({ expirada: expect.any(Boolean) });
    expect(h.getShopsByPartner).not.toHaveBeenCalled();
    expect(h.getShopInfo).not.toHaveBeenCalled();
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
  it('reports connected:true on an EXPIRED access token, without calling get_shop_info', async () => {
    // The 4-hour access token and the 7–365-day authorization are different
    // things. The legacy app rendered "Conectado" from the first and never read
    // the second; this route reports both, and a dead token costs only `loja`.
    h.readCredential.mockResolvedValue({
      access_token: 'at-fake',
      refresh_token: 'rt-fake',
      expirationDate: AGORA - 1,
    });
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ connected: true, shopId: 111, loja: null });
    expect(body.credencial).toMatchObject({ expirada: true });
    expect(body.diasParaExpirar).toBe(29);
    expect(h.getShopsByPartner).toHaveBeenCalledTimes(1);
    expect(h.getShopInfo).not.toHaveBeenCalled();
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

  it('treats an UNCOMPARABLE stored expiry as expired rather than as fresh', async () => {
    // `parseRead` is soft and returns the RAW document on a schema mismatch, so
    // `expirationDate` is not guaranteed to be a number. A comparison against
    // `undefined` answers `false` for reasons unrelated to freshness.
    h.readCredential.mockResolvedValue({
      access_token: 'at-fake',
      refresh_token: 'rt-fake',
      expirationDate: '2026-01-01T00:00:00Z',
    });
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.credencial).toMatchObject({ expirada: true });
    expect(h.getShopInfo).not.toHaveBeenCalled();
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

  it('lets an unrelated failure surface instead of swallowing it (rule 6)', async () => {
    h.getShopInfo.mockRejectedValue(new TypeError('bug nosso'));
    await expect(GET(req('int-1', { authorization: 'Bearer t' }))).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe('the response contract', () => {
  it('parses against shopeeContaStatusSchema on the connected path', async () => {
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    const body = await res.json();
    expect(() => shopeeContaStatusSchema.parse(body)).not.toThrow();
  });

  it('parses against shopeeContaStatusSchema on the disconnected path', async () => {
    h.readCredential.mockResolvedValue(null);
    const res = await GET(req('int-1', { authorization: 'Bearer t' }));
    const body = await res.json();
    expect(() => shopeeContaStatusSchema.parse(body)).not.toThrow();
  });
});
