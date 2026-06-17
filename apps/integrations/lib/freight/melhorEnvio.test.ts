import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { melhorEnvioBaseUrl } from '@delfrance/integrations-freight-br';

// Mock the seams loadMelhorEnvioContext touches so we exercise the resolver
// logic only — no Firestore, no network. The admin collection handle is faked
// (doc read + parse); the token store is the injected in-memory one; only
// `exchangeCode` is stubbed in the otherwise-real freight-br package (the rest
// — base-url/storedTokenFromResponse — stays real).
const h = vi.hoisted(() => ({
  docRefGet: vi.fn(),
  parseRead: vi.fn(),
  exchangeCode: vi.fn(),
  store: {
    saved: null as { access_token: string; refresh_token: string; expirationDate: number } | null,
    load: vi.fn(),
    save: vi.fn(),
  },
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  intFreteCollection: {
    docRef: () => ({ get: h.docRefGet }),
    parseRead: (...args: unknown[]) => h.parseRead(...args),
    docPath: (_ctx: unknown, id: string) => `int_frete/${id}`,
  },
  // Referenced by ./tokenStore at import time, but that module is mocked below.
  tokenMelEnvCollection: {},
}));

vi.mock('./tokenStore', () => ({
  createFirestoreTokenStore: () => ({
    load: h.store.load,
    save: h.store.save,
  }),
}));

vi.mock('@delfrance/integrations-freight-br', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-freight-br')>();
  return { ...actual, exchangeCode: h.exchangeCode };
});

const { loadMelhorEnvioContext, MelhorEnvioConfigError, MelhorEnvioContaNotConfiguredError } =
  await import('./melhorEnvio');

const db = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.store.saved = null;
  h.store.load.mockImplementation(async () => h.store.saved);
  h.store.save.mockImplementation(async (t) => {
    h.store.saved = t;
    return t;
  });
  vi.stubEnv('MELHOR_ENVIO_CLIENT_ID', 'cid');
  vi.stubEnv('MELHOR_ENVIO_CLIENT_SECRET', 'csecret');
  vi.stubEnv('INTEGRATIONS_PUBLIC_URL', 'http://localhost:3001');
  // Unset → sandbox is the default (prod must opt out with 'false').
  vi.stubEnv('MELHOR_ENVIO_SANDBOX', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadMelhorEnvioContext', () => {
  it('throws ContaNotConfigured when the int_frete doc is missing', async () => {
    h.docRefGet.mockResolvedValue({ exists: false });
    await expect(loadMelhorEnvioContext(db, 'int-1')).rejects.toBeInstanceOf(
      MelhorEnvioContaNotConfiguredError,
    );
  });

  it('throws ContaNotConfigured when the doc is not a Melhor Envio tipo', async () => {
    h.docRefGet.mockResolvedValue({ exists: true, data: () => ({}) });
    h.parseRead.mockReturnValue({ tipo: 'motoboy' });
    await expect(loadMelhorEnvioContext(db, 'int-1')).rejects.toBeInstanceOf(
      MelhorEnvioContaNotConfiguredError,
    );
  });

  it('throws ConfigError when the app-wide ME credentials are absent from env', async () => {
    h.docRefGet.mockResolvedValue({ exists: true, data: () => ({}) });
    h.parseRead.mockReturnValue({ tipo: 'melhorEnvios' });
    vi.stubEnv('MELHOR_ENVIO_CLIENT_ID', '');
    await expect(loadMelhorEnvioContext(db, 'int-1')).rejects.toBeInstanceOf(
      MelhorEnvioConfigError,
    );
  });

  it('builds the OAuth config from env credentials + the sandbox base URL', async () => {
    h.docRefGet.mockResolvedValue({ exists: true, data: () => ({}) });
    h.parseRead.mockReturnValue({ tipo: 'melhorEnvios' });

    const ctx = await loadMelhorEnvioContext(db, 'int-1');

    expect(ctx.intFreteId).toBe('int-1');
    expect(ctx.oauthConfig.clientId).toBe('cid');
    expect(ctx.oauthConfig.clientSecret).toBe('csecret');
    expect(ctx.oauthConfig.redirectUri).toBe(
      'http://localhost:3001/api/oauth/melhor-envio/callback',
    );
    expect(ctx.oauthConfig.baseUrl).toBe(melhorEnvioBaseUrl(true));
  });

  it('exchangeAndPersist exchanges the code and saves the derived token', async () => {
    h.docRefGet.mockResolvedValue({ exists: true, data: () => ({}) });
    h.parseRead.mockReturnValue({ tipo: 'melhorEnvios' });
    h.exchangeCode.mockResolvedValue({
      token_type: 'Bearer',
      expires_in: 2_592_000,
      access_token: 'at-1',
      refresh_token: 'rt-1',
    });

    const ctx = await loadMelhorEnvioContext(db, 'int-1');
    const saved = await ctx.exchangeAndPersist('the-code', 1_000);

    expect(h.exchangeCode).toHaveBeenCalledWith(ctx.oauthConfig, 'the-code');
    expect(saved.access_token).toBe('at-1');
    expect(saved.refresh_token).toBe('rt-1');
    expect(saved.expirationDate).toBe(1_000 + 2_592_000 * 1_000);
    expect(h.store.save).toHaveBeenCalledTimes(1);
    expect(h.store.saved?.access_token).toBe('at-1');
  });
});
