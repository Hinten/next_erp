import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { ShopeeConfigError, type ShopeeTokenPair } from '@delfrance/integrations-shopee';

/**
 * Mock the seams `loadShopeeContext` touches — no Firestore, no network. The
 * `integracao` handle is faked (doc read + parse + the denorm), the credential
 * store is an in-memory double, and only `exchangeCode` is stubbed inside the
 * otherwise-real package (so `ShopeeConfigError` and friends stay the real
 * classes the guards narrow on).
 */
const h = vi.hoisted(() => ({
  docRefGet: vi.fn(),
  mergeIfExists: vi.fn(),
  exchangeCode: vi.fn(),
  credLoad: vi.fn(),
  credSave: vi.fn(),
  tokenStore: vi.fn(),
  getOrRefresh: vi.fn(),
  createShopeeClient: vi.fn(),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  integracaoCollection: {
    docRef: () => ({ get: h.docRefGet }),
    parseRead: (raw: unknown) => raw,
    docPath: (_ctx: unknown, id: string) => `integracao/${id}`,
    mergeIfExists: h.mergeIfExists,
  },
  // Referenced by ./credentialStore at import time; that module is mocked below.
  credenciaisIntegracaoCollection: {},
}));

vi.mock('./credentialStore', async (importActual) => {
  const actual = await importActual<typeof import('./credentialStore')>();
  return {
    ...actual,
    createShopeeCredentialStore: () => ({ load: h.credLoad, save: h.credSave }),
  };
});

/**
 * The token store is exercised in full by `tokenStore.test.ts`; here only the
 * WIRING is under test, so the two entry points are stubbed. The error classes
 * stay real — `ShopeeContaSemShopIdError` is asserted with `instanceof`.
 */
vi.mock('./tokenStore', async (importActual) => {
  const actual = await importActual<typeof import('./tokenStore')>();
  return {
    ...actual,
    createShopeeTokenStore: h.tokenStore,
    getOrRefreshAccessToken: h.getOrRefresh,
  };
});

vi.mock('@delfrance/integrations-shopee', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-shopee')>();
  return { ...actual, exchangeCode: h.exchangeCode, createShopeeClient: h.createShopeeClient };
});

const {
  ShopeeContaNotConfiguredError,
  __setShopeeCacheClockForTests,
  invalidateShopeeConta,
  loadShopeeContext,
} = await import('./shopee');
const { ShopeeContaSemShopIdError } = await import('./tokenStore');

const db = {} as never;

const CONTA = { tipo: 5, nome: 'Loja BR', shop_id: 111, main_account_id: null };

const PAIR: ShopeeTokenPair = {
  accessToken: 'at-fake',
  refreshToken: 'rt-fake',
  expiresAtMs: 1_700_000_000_000,
  requestId: 'req-1',
  shopIdList: [111],
  merchantIdList: null,
};

let now = 1_700_000_000_000;
let spyWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // The reader is module-scope and every test uses `int-1`, so without this the
  // first test's document would serve the rest.
  __resetAllReadCaches();
  now = 1_700_000_000_000;
  __setShopeeCacheClockForTests(() => now);
  spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  h.docRefGet.mockResolvedValue({ exists: true, data: () => CONTA });
  h.mergeIfExists.mockResolvedValue(true);
  h.exchangeCode.mockResolvedValue(PAIR);
  h.credLoad.mockResolvedValue(null);
  h.credSave.mockResolvedValue(undefined);
  h.tokenStore.mockReturnValue({ marca: 'token-store' });
  h.getOrRefresh.mockResolvedValue('at-fake');
  h.createShopeeClient.mockReturnValue({ marca: 'shop-client' });

  vi.stubEnv('SHOPEE_PARTNER_ID', '1234567');
  vi.stubEnv('SHOPEE_PARTNER_KEY', 'chave-de-teste');
  vi.stubEnv('SHOPEE_SANDBOX', '1');
  vi.stubEnv('SHOPEE_PUBLIC_URL', 'http://localhost:3009');
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeCacheClockForTests();
  vi.unstubAllEnvs();
  spyWarn.mockRestore();
});

describe('loadShopeeContext — guards', () => {
  it('refuses a missing integração', async () => {
    h.docRefGet.mockResolvedValue({ exists: false, data: () => undefined });
    await expect(loadShopeeContext(db, 'int-1')).rejects.toBeInstanceOf(
      ShopeeContaNotConfiguredError,
    );
  });

  it('refuses an integração of another tipo', async () => {
    // Mercado Livre is tipo 1. Without this guard, `oauth/start` would mint a
    // state for a conta the Shopee callback can never legitimately connect.
    h.docRefGet.mockResolvedValue({ exists: true, data: () => ({ ...CONTA, tipo: 1 }) });
    await expect(loadShopeeContext(db, 'int-1')).rejects.toBeInstanceOf(
      ShopeeContaNotConfiguredError,
    );
  });

  it('surfaces a missing partner credential as a config error', async () => {
    vi.stubEnv('SHOPEE_PARTNER_KEY', '');
    await expect(loadShopeeContext(db, 'int-1')).rejects.toBeInstanceOf(ShopeeConfigError);
  });

  it('carries the conta and the resolved config', async () => {
    const ctx = await loadShopeeContext(db, 'int-1');
    expect(ctx.integracaoId).toBe('int-1');
    expect(ctx.conta).toMatchObject({ shop_id: 111 });
    expect(ctx.config.partnerId).toBe(1234567);
    expect(ctx.config.sandbox).toBe(true);
  });
});

describe('the conta cache', () => {
  it('serves a second load from cache', async () => {
    await loadShopeeContext(db, 'int-1');
    await loadShopeeContext(db, 'int-1');
    expect(h.docRefGet).toHaveBeenCalledTimes(1);
  });

  it('re-reads after invalidateShopeeConta', async () => {
    await loadShopeeContext(db, 'int-1');
    invalidateShopeeConta('int-1');
    await loadShopeeContext(db, 'int-1');
    expect(h.docRefGet).toHaveBeenCalledTimes(2);
  });

  it('refuses a cached conta that has not completed the consent (isFresh)', async () => {
    // A conta with no `shop_id` is back-filled by `exchangeAndPersist` on a
    // DIFFERENT instance from the ones reading it, so a hit must not be served.
    h.docRefGet.mockResolvedValue({ exists: true, data: () => ({ ...CONTA, shop_id: null }) });
    await loadShopeeContext(db, 'int-1');
    await loadShopeeContext(db, 'int-1');
    expect(h.docRefGet).toHaveBeenCalledTimes(2);
  });

  it('does not cache an absent document (negativeTtlMs: 0)', async () => {
    h.docRefGet.mockResolvedValue({ exists: false, data: () => undefined });
    await expect(loadShopeeContext(db, 'int-1')).rejects.toBeInstanceOf(
      ShopeeContaNotConfiguredError,
    );
    await expect(loadShopeeContext(db, 'int-1')).rejects.toBeInstanceOf(
      ShopeeContaNotConfiguredError,
    );
    expect(h.docRefGet).toHaveBeenCalledTimes(2);
  });
});

describe('readCredential', () => {
  it('issues a FRESH read on every call — an OAuth token is never cached', async () => {
    const ctx = await loadShopeeContext(db, 'int-1');
    await ctx.readCredential();
    await ctx.readCredential();
    expect(h.credLoad).toHaveBeenCalledTimes(2);
  });
});

describe('getAccessToken', () => {
  it('delegates to the token store with the exact deps', async () => {
    const ctx = await loadShopeeContext(db, 'int-1');
    await expect(ctx.getAccessToken()).resolves.toBe('at-fake');

    expect(h.tokenStore).toHaveBeenCalledWith(db, 'int-1');
    expect(h.getOrRefresh).toHaveBeenCalledWith({
      store: { marca: 'token-store' },
      // The package's OAuth config, never this app's wider `ShopeeConfig`.
      config: {
        partnerId: 1234567,
        partnerKey: 'chave-de-teste',
        hosts: ctx.config.hosts,
      },
      // ⚠️ The REFRESH subject, whose union has no `main_account` arm.
      subject: { kind: 'shop', shopId: 111 },
      integracaoId: 'int-1',
    });
  });
});

describe('a main-account conta (no shop_id)', () => {
  beforeEach(() => {
    h.docRefGet.mockResolvedValue({
      exists: true,
      data: () => ({ ...CONTA, shop_id: null, main_account_id: 999 }),
    });
  });

  it('LOADS — a consent with no shop is a legitimate connected state', async () => {
    // The conta route renders exactly this. Failing the loader would turn a
    // connected account into a 404 for every endpoint at once.
    const ctx = await loadShopeeContext(db, 'int-1');
    expect(ctx.conta).toMatchObject({ main_account_id: 999 });
  });

  it('refuses the two members that need a shop-signed token', async () => {
    const ctx = await loadShopeeContext(db, 'int-1');
    await expect(ctx.getAccessToken()).rejects.toBeInstanceOf(ShopeeContaSemShopIdError);
    expect(() => ctx.createShopClient()).toThrow(ShopeeContaSemShopIdError);
    // ⚠️ Resolved EAGERLY: the package would otherwise raise `ShopeeConfigError`
    // from its positive-integer assertion — a 500 reading as "the backend is
    // misconfigured" for what is a legitimate conta.
    expect(h.createShopeeClient).not.toHaveBeenCalled();
    expect(h.getOrRefresh).not.toHaveBeenCalled();
  });
});

describe('createShopClient', () => {
  it('hands the token over as a FUNCTION, called once per signed call', async () => {
    // A string would be resolved once and replayed for the whole batch, so a
    // token lapsing mid-batch could not heal.
    const ctx = await loadShopeeContext(db, 'int-1');
    expect(ctx.createShopClient()).toEqual({ marca: 'shop-client' });

    const config = h.createShopeeClient.mock.calls[0]?.[0] as {
      shopId: number;
      partnerId: number;
      getAccessToken: () => Promise<string>;
    };
    expect(config).toMatchObject({ shopId: 111, partnerId: 1234567 });
    expect(typeof config.getAccessToken).toBe('function');

    expect(h.getOrRefresh).not.toHaveBeenCalled();
    await config.getAccessToken();
    await config.getAccessToken();
    expect(h.getOrRefresh).toHaveBeenCalledTimes(2);
  });
});

describe('exchangeAndPersist', () => {
  it('writes the credential BEFORE the denorm', async () => {
    // If the denorm landed first and the credential write then failed, the
    // conta would advertise a `shop_id` it has no token for — and `isFresh`
    // would serve that document from cache. The consent code is single-use, so
    // the recovery is a re-consent either way; only this order is recoverable
    // without leaving a lie behind.
    const ordem: string[] = [];
    h.credSave.mockImplementation(async () => {
      ordem.push('credencial');
    });
    h.mergeIfExists.mockImplementation(async () => {
      ordem.push('denorm');
      return true;
    });

    const ctx = await loadShopeeContext(db, 'int-1');
    await ctx.exchangeAndPersist('the-code', { kind: 'shop', shopId: 111 }, now);

    expect(ordem).toEqual(['credencial', 'denorm']);
    expect(h.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: 1234567 }),
      'the-code',
      { kind: 'shop', shopId: 111 },
    );
  });

  it('denormalises only the id class the consent carried', async () => {
    // Writing both (with a null for the absent one) would wipe a stored
    // `main_account_id` on every shop-scoped reconnect.
    const ctx = await loadShopeeContext(db, 'int-1');
    await ctx.exchangeAndPersist('c', { kind: 'shop', shopId: 111 }, now);
    expect(h.mergeIfExists).toHaveBeenCalledWith(expect.anything(), {}, 'int-1', { shop_id: 111 });

    h.mergeIfExists.mockClear();
    await ctx.exchangeAndPersist('c', { kind: 'main_account', mainAccountId: 999 }, now);
    expect(h.mergeIfExists).toHaveBeenCalledWith(expect.anything(), {}, 'int-1', {
      main_account_id: 999,
    });
  });

  it('tolerates mergeIfExists === false instead of failing the connect', async () => {
    // The conta was deleted mid-consent. The credential is already stored and
    // the consent succeeded; telling the operator to reconnect cannot fix a
    // deleted document.
    h.mergeIfExists.mockResolvedValue(false);
    const ctx = await loadShopeeContext(db, 'int-1');
    await expect(
      ctx.exchangeAndPersist('c', { kind: 'shop', shopId: 111 }, now),
    ).resolves.toBeUndefined();
    expect(spyWarn).toHaveBeenCalledTimes(1);
  });

  it('evicts the cached conta so the next read sees the new shop_id', async () => {
    await loadShopeeContext(db, 'int-1');
    const ctx = await loadShopeeContext(db, 'int-1');
    expect(h.docRefGet).toHaveBeenCalledTimes(1);

    await ctx.exchangeAndPersist('c', { kind: 'shop', shopId: 111 }, now);
    await loadShopeeContext(db, 'int-1');
    expect(h.docRefGet).toHaveBeenCalledTimes(2);
  });

  it('does not touch the denorm when the exchange itself fails', async () => {
    h.exchangeCode.mockRejectedValue(new ShopeeConfigError('sem partner id'));
    const ctx = await loadShopeeContext(db, 'int-1');
    await expect(
      ctx.exchangeAndPersist('c', { kind: 'shop', shopId: 111 }, now),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(h.credSave).not.toHaveBeenCalled();
    expect(h.mergeIfExists).not.toHaveBeenCalled();
  });
});
