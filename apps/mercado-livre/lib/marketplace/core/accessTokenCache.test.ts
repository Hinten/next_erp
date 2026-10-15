import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  __resetAllReadCaches,
  READ_CACHE_DISABLED_ENV,
  READ_CACHE_TTL,
  readCacheStatsSnapshot,
} from '@delfrance/data/admin/cache';
import type { TokenDuravel } from '@delfrance/schemas';
import {
  MercadoLivreReauthRequiredError,
  type MercadoLivreOAuthConfig,
  type TokenResponse,
} from '@delfrance/integrations-mercado-livre';

import {
  __setAccessTokenCacheClockForTests,
  type AccessTokenScope,
  accessTokenScope,
  getCachedAccessToken,
  invalidateCachedAccessToken,
} from './accessTokenCache';
import { REFRESH_SKEW_MS, type TokenDuravelStore } from './tokenStore';

const START = 1_700_000_000_000;
const SCOPE: AccessTokenScope = ['project', 'default', 'client', 'i1'];
const CONFIG: MercadoLivreOAuthConfig = {
  clientId: 'client',
  clientSecret: 'secret',
  redirectUri: 'https://example.com/callback',
};
const RESPONSE: TokenResponse = {
  access_token: 'renewed',
  refresh_token: 'rotated-refresh',
  token_type: 'bearer',
  expires_in: 21600,
};
let now = START;

function token(accessToken = 'original', expiresAt = START + 3_600_000): TokenDuravel {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-only-in-store',
    token_type: 'bearer',
    scope: '',
    expires_in: expiresAt,
    user_id: null,
    expired: null,
  };
}

function storeWith(initial: TokenDuravel | null) {
  let current = initial;
  return {
    loadValid: vi.fn(async (cutoff: number) =>
      current != null && current.expires_in > cutoff ? current : null,
    ),
    loadLatest: vi.fn(async () => current),
    save: vi.fn(async (fresh: TokenDuravel) => {
      current = fresh;
      return fresh;
    }),
    deleteAll: vi.fn(async () => {
      const count = current === null ? 0 : 1;
      current = null;
      return count;
    }),
  } satisfies TokenDuravelStore;
}

beforeEach(() => {
  now = START;
  __resetAllReadCaches();
  __setAccessTokenCacheClockForTests(() => now);
});

afterEach(() => {
  __resetAllReadCaches();
  __setAccessTokenCacheClockForTests();
  vi.unstubAllEnvs();
});

describe('Mercado Livre access-token cache', () => {
  it('collapses repeated and simultaneous lookups into one credential query', async () => {
    const store = storeWith(token());
    expect(
      await Promise.all(
        Array.from({ length: 20 }, () => getCachedAccessToken(SCOPE, store, CONFIG)),
      ),
    ).toEqual(Array(20).fill('original'));
    expect(await getCachedAccessToken(SCOPE, store, CONFIG)).toBe('original');
    expect(store.loadValid).toHaveBeenCalledTimes(1);
    expect(store.loadLatest).not.toHaveBeenCalled();
    const stats = readCacheStatsSnapshot().find((entry) => entry.name === 'ml:access-token');
    expect(stats).toMatchObject({ misses: 1, hits: 20 });
    expect(JSON.stringify(stats)).not.toContain('original');
    expect(JSON.stringify(stats)).not.toContain('refresh-only-in-store');
  });

  it('requeries at the exact 60-second TTL boundary without refreshing a valid token', async () => {
    const store = storeWith(token());
    await getCachedAccessToken(SCOPE, store, CONFIG);
    now += READ_CACHE_TTL.volatile - 1;
    await getCachedAccessToken(SCOPE, store, CONFIG);
    expect(store.loadValid).toHaveBeenCalledTimes(1);
    now += 1;
    await getCachedAccessToken(SCOPE, store, CONFIG);
    expect(store.loadValid).toHaveBeenCalledTimes(2);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('rejects a cached token exactly at the refresh margin and shares one refresh', async () => {
    const store = storeWith(token('original', START + REFRESH_SKEW_MS + 100));
    const refresh = vi.fn(async () => RESPONSE);
    await getCachedAccessToken(SCOPE, store, CONFIG, { refresh });
    now += 100;
    expect(
      await Promise.all([
        getCachedAccessToken(SCOPE, store, CONFIG, { refresh }),
        getCachedAccessToken(SCOPE, store, CONFIG, { refresh }),
      ]),
    ).toEqual(['renewed', 'renewed']);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(CONFIG, 'refresh-only-in-store');
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save.mock.calls[0]?.[0].refresh_token).toBe('rotated-refresh');
  });

  it('keeps the namespace stable for the same Firestore handle', () => {
    // The scope needs only object identity and the public database ID, without SDK I/O.
    const db = { databaseId: 'default' } as unknown as Firestore;
    const scope = accessTokenScope(db, 'client', 'i1');

    expect(accessTokenScope(db, 'client', 'i1')).toEqual(scope);
    expect(scope.slice(1)).toEqual(['default', 'client', 'i1']);
  });

  it('isolates Firestore handles with the same database, client and account IDs', async () => {
    // Separate handles can point at separate projects; no private project property is needed.
    const firstDb = { databaseId: 'default' } as unknown as Firestore;
    const secondDb = { databaseId: 'default' } as unknown as Firestore;
    const firstScope = accessTokenScope(firstDb, 'client', 'i1');
    const secondScope = accessTokenScope(secondDb, 'client', 'i1');
    const first = storeWith(token('first'));
    const second = storeWith(token('second'));

    expect(firstScope[0]).not.toBe(secondScope[0]);
    expect(firstScope.slice(1)).toEqual(secondScope.slice(1));
    expect(await getCachedAccessToken(firstScope, first, CONFIG)).toBe('first');
    expect(await getCachedAccessToken(secondScope, second, CONFIG)).toBe('second');
    expect(second.loadValid).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2, 3])('isolates scope component %i', async (component) => {
    const first = storeWith(token('first'));
    const second = storeWith(token('second'));
    const other: [string, string, string, string] = [...SCOPE];
    other[component] += '-other';
    expect(await getCachedAccessToken(SCOPE, first, CONFIG)).toBe('first');
    expect(await getCachedAccessToken(other, second, CONFIG)).toBe('second');
    expect(second.loadValid).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure or a missing credential', async () => {
    const store = storeWith(null);
    await expect(getCachedAccessToken(SCOPE, store, CONFIG)).rejects.toBeInstanceOf(
      MercadoLivreReauthRequiredError,
    );
    await store.save(token('connected'));
    expect(await getCachedAccessToken(SCOPE, store, CONFIG)).toBe('connected');
    expect(store.loadValid).toHaveBeenCalledTimes(2);
  });

  it('bypasses cached values when DATA_READ_CACHE_DISABLED is enabled', async () => {
    const store = storeWith(token());
    await getCachedAccessToken(SCOPE, store, CONFIG);
    vi.stubEnv(READ_CACHE_DISABLED_ENV, '1');
    await store.save(token('changed'));
    expect(await getCachedAccessToken(SCOPE, store, CONFIG)).toBe('changed');
    expect(await getCachedAccessToken(SCOPE, store, CONFIG)).toBe('changed');
    expect(store.loadValid).toHaveBeenCalledTimes(3);
  });

  it('evicts a rejected token but preserves a newer token after a delayed rejection', async () => {
    const store = storeWith(token('A'));
    await getCachedAccessToken(SCOPE, store, CONFIG);
    await store.save(token('B'));
    invalidateCachedAccessToken(SCOPE, 'A');
    expect(await getCachedAccessToken(SCOPE, store, CONFIG)).toBe('B');
    invalidateCachedAccessToken(SCOPE, 'A');
    expect(await getCachedAccessToken(SCOPE, store, CONFIG)).toBe('B');
    expect(store.loadValid).toHaveBeenCalledTimes(2);
  });

  it('eviction reloads an unexpired rejected durable token without forcing refresh', async () => {
    const store = storeWith(token('A'));
    const refresh = vi.fn(async () => RESPONSE);
    await getCachedAccessToken(SCOPE, store, CONFIG, { refresh });
    invalidateCachedAccessToken(SCOPE, 'A');
    expect(await getCachedAccessToken(SCOPE, store, CONFIG, { refresh })).toBe('A');
    expect(store.loadValid).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('checks expiry after an awaited load and retries using the current clock', async () => {
    const store = storeWith(token('near-expiry', START + REFRESH_SKEW_MS + 10));
    store.loadValid.mockImplementationOnce(async () => {
      now += 10;
      return token('near-expiry', START + REFRESH_SKEW_MS + 10);
    });
    const refresh = vi.fn(async () => RESPONSE);
    expect(await getCachedAccessToken(SCOPE, store, CONFIG, { refresh })).toBe('renewed');
    expect(store.loadValid).toHaveBeenNthCalledWith(2, now + REFRESH_SKEW_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('bounds retries and never returns a newly loaded expired token', async () => {
    const store = storeWith(token());
    store.loadValid.mockImplementation(async () => token('stale', now));
    await expect(getCachedAccessToken(SCOPE, store, CONFIG)).rejects.toBeInstanceOf(
      MercadoLivreReauthRequiredError,
    );
    expect(store.loadValid).toHaveBeenCalledTimes(2);
  });

  it('does not let an invalidated pending load replace a reconnected credential', async () => {
    const store = storeWith(token('B'));
    let finish!: (value: TokenDuravel | null) => void;
    store.loadValid.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = getCachedAccessToken(SCOPE, store, CONFIG);
    invalidateCachedAccessToken(SCOPE);
    expect(await getCachedAccessToken(SCOPE, store, CONFIG)).toBe('B');
    finish(token('A'));
    await pending;
    expect(await getCachedAccessToken(SCOPE, store, CONFIG)).toBe('B');
    expect(store.loadValid).toHaveBeenCalledTimes(2);
  });

  it('keeps loser recovery queries fresh and caches only the winning access token', async () => {
    const store = storeWith(token('expired', START - 1));
    store.loadValid
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(token('winner'));
    const sleep = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => {
      throw new MercadoLivreReauthRequiredError('refresh_failed', 'already used');
    });
    expect(await getCachedAccessToken(SCOPE, store, CONFIG, { refresh, sleep })).toBe('winner');
    expect(await getCachedAccessToken(SCOPE, store, CONFIG, { refresh, sleep })).toBe('winner');
    expect(store.loadValid).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
