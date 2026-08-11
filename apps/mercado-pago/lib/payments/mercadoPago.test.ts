import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MercadoPagoHttpError,
  MercadoPagoReauthRequiredError,
  MercadoPagoValidationError,
} from '@delfrance/integrations-mercado-pago';

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
  LOSER_REREAD_DELAY_MS,
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

  /**
   * "One wins": MP rotates single-use refresh tokens, so of two callers crossing
   * the skew boundary together only one gets a fresh pair — the notification
   * queue alone dispatches 3 tasks at a time. The loser must pick up the
   * winner's credential instead of raising a re-consent prompt (#820).
   *
   * Note what `storeLoad` returns while the winner's write is in flight: the
   * SAME stale credential, not null — `load()` reads the fixed `current` doc.
   * The skew check is what tells the two apart.
   */
  describe('resolveAccessToken() loser fallback', () => {
    const stale = { access_token: 'old', refresh_token: 'RT-used', expirationDate: NOW - 1 };
    const winner = {
      access_token: 'winner',
      refresh_token: 'RT-winner',
      expirationDate: NOW + REFRESH_SKEW_MS + 10_000,
    };
    const lost = new MercadoPagoReauthRequiredError('refresh_failed', 'refresh token already used');

    /**
     * Feed `storeLoad` an exact sequence: the initial read, then the loser's
     * re-reads. Past the end it repeats the last value — a Firestore doc keeps
     * whatever state it was left in.
     *
     * ⚠️ `mockReset` is the point. The file's `beforeEach` runs
     * `vi.clearAllMocks()`, which clears recorded CALLS but NOT queued
     * `mockResolvedValueOnce` values or a persistent implementation — so a test
     * that consumed fewer reads than it queued would leak the remainder into the
     * next one, and the leak only shows up once a test starts failing.
     */
    function reads(...values: Array<Record<string, unknown> | null>): void {
      h.storeLoad.mockReset();
      let i = 0;
      h.storeLoad.mockImplementation(async () => values[Math.min(i++, values.length - 1)] ?? null);
    }

    it("uses the winner's credential when the immediate re-read finds it", async () => {
      contaDoc();
      const sleep = vi.fn(async () => undefined);
      reads(stale, winner);
      h.refreshAccessToken.mockRejectedValue(lost);

      const ctx = await loadMercadoPagoContext({} as never, 'm1');
      await expect(ctx.resolveAccessToken(NOW, { sleep })).resolves.toBe('winner');
      expect(sleep).not.toHaveBeenCalled();
      expect(h.storeSave).not.toHaveBeenCalled();
    });

    it("re-reads again after the backoff when the winner's write lands late", async () => {
      contaDoc();
      const sleep = vi.fn(async () => undefined);
      // stale (initial read) → stale (winner's write still in flight) → winner's
      reads(stale, stale, winner);
      h.refreshAccessToken.mockRejectedValue(lost);

      const ctx = await loadMercadoPagoContext({} as never, 'm1');
      await expect(ctx.resolveAccessToken(NOW, { sleep })).resolves.toBe('winner');
      expect(sleep).toHaveBeenCalledExactlyOnceWith(LOSER_REREAD_DELAY_MS);
      expect(h.storeSave).not.toHaveBeenCalled();
    });

    it('falls back on an HTTP error too (a 429 can mean the winner got there first)', async () => {
      contaDoc();
      const sleep = vi.fn(async () => undefined);
      reads(stale, winner);
      h.refreshAccessToken.mockRejectedValue(new MercadoPagoHttpError('rate limited', 429, {}));

      const ctx = await loadMercadoPagoContext({} as never, 'm1');
      await expect(ctx.resolveAccessToken(NOW, { sleep })).resolves.toBe('winner');
    });

    it('re-raises the ORIGINAL error when the credential is genuinely dead', async () => {
      contaDoc();
      const sleep = vi.fn(async () => undefined);
      reads(stale); // never becomes fresh — nobody won
      h.refreshAccessToken.mockRejectedValue(lost);

      const ctx = await loadMercadoPagoContext({} as never, 'm1');
      await expect(ctx.resolveAccessToken(NOW, { sleep })).rejects.toBe(lost);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(LOSER_REREAD_DELAY_MS);
    });

    it('does not swallow an error outside the race set', async () => {
      contaDoc();
      const sleep = vi.fn(async () => undefined);
      const bogus = new MercadoPagoValidationError('resposta inesperada', []);
      reads(stale);
      h.refreshAccessToken.mockRejectedValue(bogus);

      const ctx = await loadMercadoPagoContext({} as never, 'm1');
      await expect(ctx.resolveAccessToken(NOW, { sleep })).rejects.toBe(bogus);
      expect(sleep).not.toHaveBeenCalled();
      expect(h.storeLoad).toHaveBeenCalledTimes(1); // no re-read at all
    });
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
