import { describe, expect, it, vi } from 'vitest';

import {
  LOSER_REREAD_DELAY_MS,
  type SaveTokenOptions,
  type StoredToken,
  type TokenStore,
  getOrRefreshAccessToken,
} from '../../src/melhor-envio/token-store';
import {
  MelhorEnvioHttpError,
  MelhorEnvioNetworkError,
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

/** A token comfortably past the skew — what a concurrent winner would write. */
function fresh(over: Partial<StoredToken> = {}): StoredToken {
  return {
    access_token: 'fresh',
    refresh_token: 'freshR',
    expirationDate: NOW + 9 * 60_000,
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

/**
 * A store whose `load()` follows an exact SEQUENCE: the fast-path read, then the
 * loser fallback's two re-reads. Past the end it repeats the last value — a
 * Firestore doc keeps whatever state it was left in.
 *
 * This is what `memStore` cannot express. The pre-#966 race test simulated the
 * race by having the fake `refresh` call `store.save()` *before* throwing, i.e.
 * the winner's write always landed first — the FAVOURABLE ordering, and
 * therefore the one ordering that could never fail on the bug.
 */
function seqStore(...loads: (StoredToken | null)[]): TokenStore & { saved: StoredToken[] } {
  const saved: StoredToken[] = [];
  let i = 0;
  return {
    saved,
    load: async () => loads[Math.min(i++, loads.length - 1)] ?? null,
    save: async (t: StoredToken, _options?: SaveTokenOptions) => {
      saved.push(t);
      return t;
    },
  };
}

/** The token we are trying (and failing) to refresh — stale by definition. */
const stale: StoredToken = {
  access_token: 'A',
  refresh_token: 'staleR',
  expirationDate: NOW - 1000,
};

const noSleep = async (): Promise<void> => undefined;

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

  it('returns what save() returns, not what it was handed', async () => {
    // The store's update-if-newer guard can keep a concurrently-written newer
    // credential and hand it back (#966). This function must propagate that
    // rather than assume its own argument won the write.
    const winner = fresh({ access_token: 'winner-write' });
    const store: TokenStore = {
      load: async () => stale,
      save: async () => winner,
    };
    const refresh = vi.fn(async () => tokenResp({ access_token: 'mine' }));
    const out = await getOrRefreshAccessToken({ store, refresh, now: () => NOW, skewMs: SKEW });
    expect(out).toBe(winner);
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
      // Stubbed: a genuinely dead grant always reaches the backoff before it
      // gives up, and a real timer here would make every run 250 ms slower.
      sleep: noSleep,
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
      await store.save(fresh());
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
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MelhorEnvioHttpError);
    expect(err).not.toBeInstanceOf(MelhorEnvioReauthRequiredError);
  });

  /**
   * The loser's re-read races the winner's `save()`, and loses it more often
   * than not: ME rejects our used `refresh_token` faster than it mints and
   * rotates a pair for the winner. One immediate read is therefore not enough.
   *
   * The race is driven by a SEQUENCED store plus an injected `sleep` spy — no
   * fake timers, no deferred promises. Same technique as
   * `apps/mercado-livre/lib/marketplace/tokenStore.test.ts` (#820).
   */
  describe('loser fallback backoff', () => {
    it("re-reads again after the backoff when the winner's write lands late", async () => {
      const sleep = vi.fn(async () => undefined);
      const winner = fresh({ access_token: 'late-winner' });
      // fast path stale → immediate re-read STILL stale (write in flight) → it lands
      const store = seqStore(stale, stale, winner);
      const refresh = vi.fn(async () => {
        throw new MelhorEnvioHttpError('invalid_grant', 400, { error: 'invalid_grant' });
      });

      const out = await getOrRefreshAccessToken({
        store,
        refresh,
        now: () => NOW,
        skewMs: SKEW,
        sleep,
      });

      expect(out.access_token).toBe('late-winner');
      expect(sleep).toHaveBeenCalledExactlyOnceWith(LOSER_REREAD_DELAY_MS);
      expect(store.saved).toHaveLength(0); // the loser never writes
    });

    it('does not wait when the immediate re-read already finds the winner', async () => {
      const sleep = vi.fn(async () => undefined);
      const store = seqStore(stale, fresh({ access_token: 'winner' }));
      const refresh = vi.fn(async () => {
        throw new MelhorEnvioHttpError('invalid_grant', 401, { error: 'invalid_grant' });
      });

      const out = await getOrRefreshAccessToken({
        store,
        refresh,
        now: () => NOW,
        skewMs: SKEW,
        sleep,
      });

      expect(out.access_token).toBe('winner');
      expect(sleep).not.toHaveBeenCalled();
    });

    it('falls back on a 429 too — a rate limit means the winner got there first', async () => {
      // The case the old 400/401/403 triple excluded outright: ME rate-limiting
      // the token endpoint is *most* likely exactly when two refreshes collide.
      const sleep = vi.fn(async () => undefined);
      const store = seqStore(stale, stale, fresh({ access_token: 'winner-429' }));
      const refresh = vi.fn(async () => {
        throw new MelhorEnvioHttpError('rate limited', 429, {});
      });

      const out = await getOrRefreshAccessToken({
        store,
        refresh,
        now: () => NOW,
        skewMs: SKEW,
        sleep,
      });

      expect(out.access_token).toBe('winner-429');
      expect(sleep).toHaveBeenCalledExactlyOnceWith(LOSER_REREAD_DELAY_MS);
    });

    it('raises ReauthRequired after one backoff when the grant is genuinely dead', async () => {
      const sleep = vi.fn(async () => undefined);
      const store = seqStore(stale); // never becomes fresh — nobody won
      const refresh = vi.fn(async () => {
        throw new MelhorEnvioHttpError('invalid_grant', 400, { error: 'invalid_grant' });
      });

      const err = await getOrRefreshAccessToken({
        store,
        refresh,
        now: () => NOW,
        skewMs: SKEW,
        sleep,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MelhorEnvioReauthRequiredError);
      expect((err as MelhorEnvioReauthRequiredError).status).toBe(400);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(LOSER_REREAD_DELAY_MS);
    });

    it('re-raises the ORIGINAL error on a 5xx when both re-reads are empty', async () => {
      // A transient failure must NOT be translated into "reconnect the account"
      // — the account is fine, ME is not. Only the dead-grant statuses convert.
      const sleep = vi.fn(async () => undefined);
      const dead = new MelhorEnvioHttpError('server', 503, null);
      const store = seqStore(stale);
      const refresh = vi.fn(async () => {
        throw dead;
      });

      await expect(
        getOrRefreshAccessToken({ store, refresh, now: () => NOW, skewMs: SKEW, sleep }),
      ).rejects.toBe(dead);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(LOSER_REREAD_DELAY_MS);
    });

    it('does not re-read at all for an error outside the race set', async () => {
      // A network failure never reached ME, so no winner can exist because of
      // it. `MelhorEnvioNetworkError` is not an HttpError and must bubble
      // untouched, without paying the backoff.
      const sleep = vi.fn(async () => undefined);
      const bogus = new MelhorEnvioNetworkError('econnreset');
      const store = seqStore(stale, fresh()); // a winner IS there — must be ignored
      const refresh = vi.fn(async () => {
        throw bogus;
      });

      await expect(
        getOrRefreshAccessToken({ store, refresh, now: () => NOW, skewMs: SKEW, sleep }),
      ).rejects.toBe(bogus);
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});
