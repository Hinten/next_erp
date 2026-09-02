import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import type { Integracao } from '@delfrance/schemas';

// Mock the seams loadMercadoLivreContext touches so we exercise the resolver
// logic only — no Firestore, no network. The admin collection handle is faked
// (doc read + parse + merge); the token store + refresh are the ones from
// `./tokenStore`, injected so no real HTTP happens.
const h = vi.hoisted(() => ({
  docRefGet: vi.fn(),
  parseRead: vi.fn(),
  merge: vi.fn(),
  createTokenDuravelStore: vi.fn(),
  getOrRefreshAccessToken: vi.fn(),
  exchangeCode: vi.fn(),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  integracaoCollection: {
    docRef: () => ({ get: h.docRefGet }),
    parseRead: (...args: unknown[]) => h.parseRead(...args),
    docPath: (_ctx: unknown, id: string) => `integracao/${id}`,
    merge: (...args: unknown[]) => h.merge(...args),
  },
}));

vi.mock('./tokenStore', () => ({
  createTokenDuravelStore: (...args: unknown[]) => h.createTokenDuravelStore(...args),
  getOrRefreshAccessToken: (...args: unknown[]) => h.getOrRefreshAccessToken(...args),
  tokenDuravelFromResponse: (resp: { access_token: string }, now: number) => ({
    access_token: resp.access_token,
    refresh_token: 'RT',
    token_type: 'bearer',
    scope: '',
    expires_in: now + 1000,
    user_id: null,
    expired: null,
  }),
}));

vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return {
    ...actual,
    exchangeCode: (...args: unknown[]) => h.exchangeCode(...args),
  };
});

const {
  loadMercadoLivreContext,
  mercadoLivreAccountBag,
  mercadoLivreRedirectUri,
  MercadoLivreContaNotConfiguredError,
  MercadoLivreConfigError,
} = await import('./mercadoLivre');

const db = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  // The conta cache is module-scope and every test here uses the id `int-1`,
  // so without this the first test's absent-document entry serves the rest.
  __resetAllReadCaches();
  h.createTokenDuravelStore.mockReturnValue({ save: vi.fn() });
  h.getOrRefreshAccessToken.mockResolvedValue('AT');
  vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', 'cid');
  vi.stubEnv('MERCADO_LIVRE_CLIENT_SECRET', 'csecret');
  vi.stubEnv('MERCADO_LIVRE_PUBLIC_URL', 'http://localhost:3006');
});

afterEach(() => {
  __resetAllReadCaches();
  vi.unstubAllEnvs();
});

describe('mercadoLivreRedirectUri', () => {
  const CAMINHO = '/api/oauth/mercado-livre/callback';

  it('builds the callback URI from MERCADO_LIVRE_PUBLIC_URL', () => {
    vi.stubEnv('MERCADO_LIVRE_PUBLIC_URL', 'https://ml.example.com');
    expect(mercadoLivreRedirectUri()).toBe(`https://ml.example.com${CAMINHO}`);
  });

  it('strips a trailing slash so the URI matches the ML registration exactly', () => {
    vi.stubEnv('MERCADO_LIVRE_PUBLIC_URL', 'https://ml.example.com/');
    expect(mercadoLivreRedirectUri()).toBe(`https://ml.example.com${CAMINHO}`);
  });

  it('falls back to localhost when the origin is unset', () => {
    vi.stubEnv('MERCADO_LIVRE_PUBLIC_URL', undefined);
    expect(mercadoLivreRedirectUri()).toBe(`http://localhost:3006${CAMINHO}`);
  });

  it.each(['', '   '])('treats a blank origin (%j) as unset', (valor) => {
    // The old `??` guarded only undefined/null, so a blank env var produced
    // `base === ''` and sent the RELATIVE "/api/oauth/..." to ML as the
    // redirect_uri — a 400 at the token step that this app could not report.
    // Same `??`-versus-empty-string hole #887 fixed for *_TASKS_REGION.
    vi.stubEnv('MERCADO_LIVRE_PUBLIC_URL', valor);
    expect(mercadoLivreRedirectUri()).toBe(`http://localhost:3006${CAMINHO}`);
  });
});

describe('mercadoLivreAccountBag', () => {
  it('carries only user_id', () => {
    const bag = mercadoLivreAccountBag({
      user_id: 42,
      // Extra passthrough / typed fields the bag must NOT leak — including the
      // dropped legacy Mercado-Shops refs a Flutter-written doc still carries.
      shop_id: 99,
      tabelaNormalOuterRef: 'listaDePrecos/normal',
      tabelaMercadoShopsOuterRef: 'listaDePrecos/ms1',
      tabelaMercadoShopsPromocionalOuterRef: 'listaDePrecos/ms2',
    } as unknown as Integracao);
    expect(bag).toEqual({ user_id: 42 });
  });

  it('passes through a null user_id when the account has none set', () => {
    const bag = mercadoLivreAccountBag({ user_id: null } as unknown as Integracao);
    expect(bag).toEqual({ user_id: null });
  });
});

describe('loadMercadoLivreContext', () => {
  it('throws ContaNotConfigured when the integração doc is missing', async () => {
    h.docRefGet.mockResolvedValue({ exists: false });
    await expect(loadMercadoLivreContext(db, 'int-1')).rejects.toBeInstanceOf(
      MercadoLivreContaNotConfiguredError,
    );
  });

  it('throws ContaNotConfigured when the doc is not a Mercado Livre tipo', async () => {
    h.docRefGet.mockResolvedValue({ exists: true, data: () => ({}) });
    h.parseRead.mockReturnValue({ tipo: 5 }); // shopee
    await expect(loadMercadoLivreContext(db, 'int-1')).rejects.toBeInstanceOf(
      MercadoLivreContaNotConfiguredError,
    );
  });

  it('throws ConfigError when the app-wide ML credentials are absent from env', async () => {
    h.docRefGet.mockResolvedValue({ exists: true, data: () => ({}) });
    h.parseRead.mockReturnValue({ tipo: 1 });
    vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', '');
    await expect(loadMercadoLivreContext(db, 'int-1')).rejects.toBeInstanceOf(
      MercadoLivreConfigError,
    );
  });

  it('resolveChannelContext packs the typed account bag off the parsed conta', async () => {
    h.docRefGet.mockResolvedValue({ exists: true, data: () => ({}) });
    h.parseRead.mockReturnValue({
      tipo: 1,
      user_id: 7,
      shop_id: 123, // some other channel's field — must not leak into the bag
      tabelaMercadoShopsOuterRef: 'listaDePrecos/ms1', // dropped legacy field — must not leak either
    });

    const ctx = await loadMercadoLivreContext(db, 'int-1');
    const channelCtx = await ctx.resolveChannelContext(1_000);

    // ⚠️ Destructured so the `toEqual` below stays EXHAUSTIVE over the data half
    // — that is what catches `shop_id` / the dropped legacy ref leaking into the
    // bag. Comparing the whole object would need the function listed too, and
    // `expect.any(Function)` would quietly accept a new stray field beside it.
    const { getAccessToken, ...dados } = channelCtx;

    expect(dados).toEqual({
      integracaoId: 'int-1',
      accessToken: 'AT',
      account: { user_id: 7 },
    });
    // The thunk is the half that survives a long-running job (#815 amendment 4):
    // `accessToken` froze at `now = 1_000`, this re-reads the store per call.
    expect(await getAccessToken()).toBe('AT');
  });

  it('exchangeAndPersist denormalizes user_id onto the integração doc', async () => {
    h.docRefGet.mockResolvedValue({ exists: true, data: () => ({}) });
    h.parseRead.mockReturnValue({ tipo: 1, user_id: null });
    h.exchangeCode.mockResolvedValue({ access_token: 'AT2', user_id: 55 });

    const ctx = await loadMercadoLivreContext(db, 'int-1');
    await ctx.exchangeAndPersist('the-code');

    expect(h.merge).toHaveBeenCalledWith(db, {}, 'int-1', { user_id: 55 });
  });
});
