import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoPagoReauthRequiredError } from '@delfrance/integrations-mercado-pago';

// Mock the three seams: the metodo_pgto handle (Firestore), the credential
// store, and the MP OAuth token calls. `credentialFromResponse` + buildAuthorizeUrl
// + the error classes stay REAL so expiry math and the consent URL round-trip.
const h = vi.hoisted(() => ({
  docRef: vi.fn(),
  parseRead: vi.fn(),
  merge: vi.fn(async () => undefined),
  storeLoad: vi.fn(),
  storeSave: vi.fn(async (c: unknown) => c),
  exchangeCode: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  metodoPagamentoCollection: {
    docRef: h.docRef,
    parseRead: h.parseRead,
    docPath: (_ctx: unknown, id: string) => `metodo_pgto/${id}`,
    merge: h.merge,
  },
}));

vi.mock('./credentialStore', async (importActual) => {
  const actual = await importActual<typeof import('./credentialStore')>();
  return {
    ...actual,
    createCredentialStore: () => ({ load: h.storeLoad, save: h.storeSave }),
  };
});

vi.mock('@delfrance/integrations-mercado-pago', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-pago')>();
  return { ...actual, exchangeCode: h.exchangeCode, refreshAccessToken: h.refreshAccessToken };
});

const {
  loadMercadoPagoContext,
  mercadoPagoOAuthConfig,
  mercadoPagoRedirectUri,
  MercadoPagoConfigError,
  MercadoPagoContaNotConfiguredError,
  REFRESH_SKEW_MS,
} = await import('./mercadoPago');

const NOW = 1_700_000_000_000;

/** Prime the loader to resolve a valid Mercado Pago metodo_pgto doc. */
function contaDoc(over: Record<string, unknown> = {}): void {
  h.docRef.mockReturnValue({ get: async () => ({ exists: true, data: () => ({}) }) });
  h.parseRead.mockReturnValue({ tipo: 1, nome: 'Loja MP', user_id: null, ...over });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MERCADO_PAGO_CLIENT_ID', 'CID');
  vi.stubEnv('MERCADO_PAGO_CLIENT_SECRET', 'CSECRET');
  vi.stubEnv('MERCADO_PAGO_PUBLIC_URL', 'http://localhost:3007');
  h.storeSave.mockImplementation(async (c: unknown) => c);
  h.merge.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mercadoPagoRedirectUri', () => {
  it('builds the callback URI from MERCADO_PAGO_PUBLIC_URL (trailing slash trimmed)', () => {
    vi.stubEnv('MERCADO_PAGO_PUBLIC_URL', 'https://mp.example.com/');
    expect(mercadoPagoRedirectUri()).toBe('https://mp.example.com/api/oauth/mercado-pago/callback');
  });
});

describe('mercadoPagoOAuthConfig', () => {
  it('throws MercadoPagoConfigError when the app credentials are absent', () => {
    vi.stubEnv('MERCADO_PAGO_CLIENT_ID', '');
    expect(() => mercadoPagoOAuthConfig()).toThrow(MercadoPagoConfigError);
  });

  it('returns the resolved config when the credentials are set', () => {
    expect(mercadoPagoOAuthConfig()).toEqual({
      clientId: 'CID',
      clientSecret: 'CSECRET',
      redirectUri: 'http://localhost:3007/api/oauth/mercado-pago/callback',
    });
  });
});

describe('loadMercadoPagoContext', () => {
  it('throws MercadoPagoContaNotConfiguredError when the doc is missing', async () => {
    h.docRef.mockReturnValue({ get: async () => ({ exists: false }) });
    await expect(loadMercadoPagoContext({} as never, 'm1')).rejects.toBeInstanceOf(
      MercadoPagoContaNotConfiguredError,
    );
  });

  it('throws MercadoPagoContaNotConfiguredError when the account is not tipo mercadoPago', async () => {
    h.docRef.mockReturnValue({ get: async () => ({ exists: true, data: () => ({}) }) });
    h.parseRead.mockReturnValue({ tipo: 99, nome: 'X' });
    await expect(loadMercadoPagoContext({} as never, 'm1')).rejects.toBeInstanceOf(
      MercadoPagoContaNotConfiguredError,
    );
  });

  it('authorizeUrl() builds the MP consent URL with client_id, redirect_uri and state', async () => {
    contaDoc();
    const ctx = await loadMercadoPagoContext({} as never, 'm1');
    const url = new URL(ctx.authorizeUrl('SIGNED_STATE'));
    expect(url.searchParams.get('client_id')).toBe('CID');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3007/api/oauth/mercado-pago/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('SIGNED_STATE');
  });

  it('resolveAccessToken() returns the stored token while it is comfortably valid', async () => {
    contaDoc();
    h.storeLoad.mockResolvedValue({
      access_token: 'live',
      refresh_token: 'RT',
      expirationDate: NOW + REFRESH_SKEW_MS + 10_000,
    });
    const ctx = await loadMercadoPagoContext({} as never, 'm1');
    const at = await ctx.resolveAccessToken(NOW);
    expect(at).toBe('live');
    expect(h.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('resolveAccessToken() refreshes near expiry and persists the rotated credential', async () => {
    contaDoc();
    h.storeLoad.mockResolvedValue({
      access_token: 'old',
      refresh_token: 'RT-old',
      expirationDate: NOW - 1,
    });
    h.refreshAccessToken.mockResolvedValue({
      access_token: 'AT2',
      token_type: 'bearer',
      expires_in: 21_600,
      scope: 'read write',
      user_id: 7,
      refresh_token: 'RT2',
    });
    const ctx = await loadMercadoPagoContext({} as never, 'm1');
    const at = await ctx.resolveAccessToken(NOW);

    expect(h.refreshAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'CID', clientSecret: 'CSECRET' }),
      'RT-old',
    );
    expect(at).toBe('AT2');
    expect(h.storeSave).toHaveBeenCalledTimes(1);
    expect(h.storeSave.mock.calls[0]![0]).toEqual({
      access_token: 'AT2',
      refresh_token: 'RT2',
      expirationDate: NOW + 21_600 * 1000 - 5000,
    });
  });

  it('resolveAccessToken() throws reauth-required when there is no stored credential', async () => {
    contaDoc();
    h.storeLoad.mockResolvedValue(null);
    const ctx = await loadMercadoPagoContext({} as never, 'm1');
    await expect(ctx.resolveAccessToken(NOW)).rejects.toBeInstanceOf(
      MercadoPagoReauthRequiredError,
    );
    expect(h.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('exchangeAndPersist() exchanges the code, persists the credential and denormalizes user_id', async () => {
    contaDoc();
    h.exchangeCode.mockResolvedValue({
      access_token: 'AT',
      token_type: 'bearer',
      expires_in: 15_552_000,
      scope: 'read',
      user_id: 4242,
      refresh_token: 'RT',
    });
    const ctx = await loadMercadoPagoContext({} as never, 'm1');
    await ctx.exchangeAndPersist('auth-code', NOW);

    expect(h.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'CID' }),
      'auth-code',
    );
    expect(h.storeSave).toHaveBeenCalledWith({
      access_token: 'AT',
      refresh_token: 'RT',
      expirationDate: NOW + 15_552_000 * 1000 - 5000,
    });
    expect(h.merge).toHaveBeenCalledWith(expect.anything(), {}, 'm1', { user_id: 4242 });
  });

  it('exchangeAndPersist() skips the user_id merge when MP omits the collector id', async () => {
    contaDoc();
    h.exchangeCode.mockResolvedValue({
      access_token: 'AT',
      token_type: 'bearer',
      expires_in: 100,
      refresh_token: 'RT',
    });
    const ctx = await loadMercadoPagoContext({} as never, 'm1');
    await ctx.exchangeAndPersist('auth-code', NOW);

    expect(h.storeSave).toHaveBeenCalledTimes(1);
    expect(h.merge).not.toHaveBeenCalled();
  });
});
