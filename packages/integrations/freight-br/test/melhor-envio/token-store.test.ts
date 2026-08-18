import { describe, expect, it, vi } from 'vitest';

import {
  type StoredToken,
  type TokenStore,
  getOrRefreshAccessToken,
} from '../../src/melhor-envio/token-store';
import {
  MelhorEnvioHttpError,
  MelhorEnvioReauthRequiredError,
} from '../../src/melhor-envio/errors';
import type { TokenResponse } from '../../src/melhor-envio/types';

const NOW = 1_700_000_000_000;
const SKEW = 60_000;

function tokenResp(over: Partial<TokenResponse> = {}): TokenResponse {
  return {
    token_type: 'Bearer',
    expires_in: 2_592_000,
    access_token: 'A',
    refresh_token: 'R',
    ...over,
  };
}

/** In-memory single-token store. `save` replaces all docs (single-token). */
function memStore(initial: StoredToken | null): TokenStore & { docs: StoredToken[] } {
  const state = { docs: initial ? [initial] : ([] as StoredToken[]) };
  return {
    docs: state.docs,
    load: async () =>
      state.docs.length === 0
        ? null
        : [...state.docs].sort((a, b) => b.expirationDate - a.expirationDate)[0]!,
    save: async (t: StoredToken) => {
      state.docs.length = 0;
      state.docs.push(t);
      return t;
    },
  };
}

describe('getOrRefreshAccessToken', () => {
  it('returns the current token when comfortably valid (no refresh)', async () => {
    const store = memStore({
      access_token: 'A',
      refresh_token: 'R',
      expirationDate: NOW + 10 * 60_000,
    });
    const refresh = vi.fn(async () => tokenResp());
    const out = await getOrRefreshAccessToken({ store, refresh, now: () => NOW, skewMs: SKEW });
    expect(out.access_token).toBe('A');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes within the skew window and saves single-token', async () => {
    const store = memStore({
      access_token: 'old',
      refresh_token: 'oldR',
      expirationDate: NOW + 30_000,
    });
    const refresh = vi.fn(async () =>
      tokenResp({ access_token: 'new', refresh_token: 'newR', expires_in: 100 }),
    );
    const out = await getOrRefreshAccessToken({ store, refresh, now: () => NOW, skewMs: SKEW });
    expect(refresh).toHaveBeenCalledWith('oldR');
    expect(out.access_token).toBe('new');
    expect(out.expirationDate).toBe(NOW + 100 * 1000);
    expect(store.docs).toHaveLength(1);
    expect(store.docs[0]!.refresh_token).toBe('newR');
  });

  it('throws ReauthRequired(no_token) when no token exists', async () => {
    const store = memStore(null);
    const refresh = vi.fn(async () => tokenResp());
    await expect(
      getOrRefreshAccessToken({ store, refresh, now: () => NOW, skewMs: SKEW }),
    ).rejects.toMatchObject({ name: 'MelhorEnvioReauthRequiredError', reason: 'no_token' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('throws ReauthRequired(refresh_failed) when the refresh grant is rejected', async () => {
    const store = memStore({
      access_token: 'A',
      refresh_token: 'deadR',
      expirationDate: NOW - 1000,
    });
    const refresh = vi.fn(async () => {
      throw new MelhorEnvioHttpError('invalid_grant', 401, { error: 'invalid_grant' });
    });
    const err = await getOrRefreshAccessToken({
      store,
      refresh,
      now: () => NOW,
      skewMs: SKEW,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MelhorEnvioReauthRequiredError);
    expect((err as MelhorEnvioReauthRequiredError).reason).toBe('refresh_failed');
    // ⚠️ status/body come from the REJECTING response, at the only production
    // throw site. Adding the field without passing it here left it permanently
    // null — the class advertised diagnostics it never carried.
    expect((err as MelhorEnvioReauthRequiredError).status).toBe(401);
    expect((err as MelhorEnvioReauthRequiredError).body).toEqual({ error: 'invalid_grant' });
  });

  it('falls back to a concurrently-refreshed token on a 401 (no re-auth)', async () => {
    // Our refresh fails (another worker already rotated the token), but a
    // re-read finds the fresh token they saved → return it.
    const store = memStore({
      access_token: 'A',
      refresh_token: 'staleR',
      expirationDate: NOW - 1000,
    });
    const refresh = vi.fn(async () => {
      // Simulate the concurrent worker's save landing before our re-read.
      await store.save({
        access_token: 'fresh',
        refresh_token: 'freshR',
        expirationDate: NOW + 9 * 60_000,
      });
      throw new MelhorEnvioHttpError('invalid_grant', 400, { error: 'invalid_grant' });
    });
    const out = await getOrRefreshAccessToken({ store, refresh, now: () => NOW, skewMs: SKEW });
    expect(out.access_token).toBe('fresh');
  });

  it('bubbles a transient 5xx refresh failure (not re-auth)', async () => {
    const store = memStore({ access_token: 'A', refresh_token: 'R', expirationDate: NOW - 1000 });
    const refresh = vi.fn(async () => {
      throw new MelhorEnvioHttpError('server', 500, null);
    });
    const err = await getOrRefreshAccessToken({
      store,
      refresh,
      now: () => NOW,
      skewMs: SKEW,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MelhorEnvioHttpError);
    expect(err).not.toBeInstanceOf(MelhorEnvioReauthRequiredError);
  });
});
