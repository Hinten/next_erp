import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  READ_CACHE_DISABLED_ENV,
  READ_CACHE_TTL,
  __resetAllReadCaches,
} from '@delfrance/data/admin/cache';
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

const {
  loadMelhorEnvioContext,
  melhorEnvioRedirectUri,
  MelhorEnvioConfigError,
  MelhorEnvioContaNotConfiguredError,
  __setMelhorEnvioCacheClockForTests,
} = await import('./melhorEnvio');

const db = {} as never;

let now = 1_700_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  // The int_frete reader is module-scope and every test here uses `int-1`, so
  // without this the first test's absent-document entry serves the rest.
  __resetAllReadCaches();
  now = 1_700_000_000_000;
  __setMelhorEnvioCacheClockForTests(() => now);
  h.store.saved = null;
  h.store.load.mockImplementation(async () => h.store.saved);
  h.store.save.mockImplementation(async (t) => {
    h.store.saved = t;
    return t;
  });
  vi.stubEnv('MELHOR_ENVIO_CLIENT_ID', 'cid');
  vi.stubEnv('MELHOR_ENVIO_CLIENT_SECRET', 'csecret');
  vi.stubEnv('MELHOR_ENVIO_PUBLIC_URL', 'http://localhost:3005');
  // Unset → sandbox is the default (prod must opt out with 'false').
  vi.stubEnv('MELHOR_ENVIO_SANDBOX', '');
});

afterEach(() => {
  __resetAllReadCaches();
  __setMelhorEnvioCacheClockForTests();
  vi.unstubAllEnvs();
});

describe('melhorEnvioRedirectUri', () => {
  const CAMINHO = '/api/oauth/melhor-envio/callback';

  it('builds the callback URI from MELHOR_ENVIO_PUBLIC_URL', () => {
    vi.stubEnv('MELHOR_ENVIO_PUBLIC_URL', 'https://me.example.com');
    expect(melhorEnvioRedirectUri()).toBe(`https://me.example.com${CAMINHO}`);
  });

  it('strips a trailing slash so the URI matches the ME registration exactly', () => {
    vi.stubEnv('MELHOR_ENVIO_PUBLIC_URL', 'https://me.example.com/');
    expect(melhorEnvioRedirectUri()).toBe(`https://me.example.com${CAMINHO}`);
  });

  it('falls back to localhost when the origin is unset', () => {
    vi.stubEnv('MELHOR_ENVIO_PUBLIC_URL', undefined);
    expect(melhorEnvioRedirectUri()).toBe(`http://localhost:3005${CAMINHO}`);
  });

  it.each(['', '   '])('treats a blank origin (%j) as unset', (valor) => {
    // The old `??` guarded only undefined/null, so a blank env var produced
    // `base === ''` and sent the RELATIVE "/api/oauth/melhor-envio/callback" to ME
    // as the redirect_uri — a silent mismatch, since nothing on this path logged.
    // Same `??`-versus-empty-string hole #887 fixed for *_TASKS_REGION.
    vi.stubEnv('MELHOR_ENVIO_PUBLIC_URL', valor);
    expect(melhorEnvioRedirectUri()).toBe(`http://localhost:3005${CAMINHO}`);
  });
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
      'http://localhost:3005/api/oauth/melhor-envio/callback',
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

describe('loadMelhorEnvioContext — the int_frete read cache', () => {
  function seedConta(): void {
    h.docRefGet.mockResolvedValue({ exists: true, data: () => ({}) });
    h.parseRead.mockReturnValue({ tipo: 'melhorEnvios' });
  }

  it('serves a repeated load from cache', async () => {
    seedConta();

    await loadMelhorEnvioContext(db, 'int-1');
    await loadMelhorEnvioContext(db, 'int-1');

    expect(h.docRefGet).toHaveBeenCalledTimes(1);
  });

  it('re-reads after ttlMs — the staleness contract, not just the hit', async () => {
    seedConta();

    await loadMelhorEnvioContext(db, 'int-1');
    now += READ_CACHE_TTL.config - 1;
    await loadMelhorEnvioContext(db, 'int-1');
    expect(h.docRefGet).toHaveBeenCalledTimes(1);

    // The boundary is EXCLUSIVE: at exactly `ttlMs` the entry is expired.
    now += 1;
    await loadMelhorEnvioContext(db, 'int-1');
    expect(h.docRefGet).toHaveBeenCalledTimes(2);
  });

  it('still throws on a wrong tipo when the value came from cache', async () => {
    // The reader replaced the READ, not the contract: the guard runs against
    // the cached value on every call, not just the first.
    h.docRefGet.mockResolvedValue({ exists: true, data: () => ({}) });
    h.parseRead.mockReturnValue({ tipo: 'motoboy' });

    await expect(loadMelhorEnvioContext(db, 'int-1')).rejects.toBeInstanceOf(
      MelhorEnvioContaNotConfiguredError,
    );
    await expect(loadMelhorEnvioContext(db, 'int-1')).rejects.toBeInstanceOf(
      MelhorEnvioContaNotConfiguredError,
    );
    expect(h.docRefGet).toHaveBeenCalledTimes(1);
  });

  it('never caches an absent document', async () => {
    h.docRefGet.mockResolvedValue({ exists: false });
    await expect(loadMelhorEnvioContext(db, 'int-1')).rejects.toBeInstanceOf(
      MelhorEnvioContaNotConfiguredError,
    );

    // An integration re-created moments later resolves without waiting out a TTL.
    seedConta();
    await expect(loadMelhorEnvioContext(db, 'int-1')).resolves.toBeDefined();
  });

  it('passes through when the kill switch is set', async () => {
    vi.stubEnv(READ_CACHE_DISABLED_ENV, '1');
    seedConta();

    await loadMelhorEnvioContext(db, 'int-1');
    await loadMelhorEnvioContext(db, 'int-1');

    expect(h.docRefGet).toHaveBeenCalledTimes(2);
  });
});
