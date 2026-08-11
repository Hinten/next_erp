import { describe, expect, it, vi } from 'vitest';
import {
  MercadoLivreHttpError,
  type MercadoLivreOAuthConfig,
  MercadoLivreReauthRequiredError,
  type TokenResponse,
} from '@delfrance/integrations-mercado-livre';
import type { TokenDuravel } from '@delfrance/schemas';

import {
  LOSER_REREAD_DELAY_MS,
  type TokenDuravelStore,
  getOrRefreshAccessToken,
  tokenDuravelFromResponse,
} from './tokenStore';

const NOW = 1_000_000_000;
const HOUR = 3_600_000;
const config: MercadoLivreOAuthConfig = {
  clientId: 'c',
  clientSecret: 's',
  redirectUri: 'https://app/callback',
};

function tok(over: Partial<TokenDuravel> = {}): TokenDuravel {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    token_type: 'bearer',
    scope: '',
    expires_in: NOW + HOUR,
    user_id: null,
    expired: null,
    ...over,
  };
}

const RESP: TokenResponse = {
  access_token: 'AT2',
  token_type: 'bearer',
  expires_in: 21600,
  scope: 'offline_access read write',
  user_id: 7,
  refresh_token: 'RT2',
};

/**
 * Configurable in-memory store. `validSeq` feeds successive `loadValid` calls
 * (fast path, then the loser re-read); `latest` is what `loadLatest` returns
 * (the token whose refresh_token drives a refresh).
 */
function fakeStore(opts: {
  valid?: TokenDuravel | null;
  validSeq?: (TokenDuravel | null)[];
  latest?: TokenDuravel | null;
}): TokenDuravelStore & { persisted: TokenDuravel[] } {
  const persisted: TokenDuravel[] = [];
  let i = 0;
  return {
    persisted,
    async loadValid() {
      if (opts.validSeq) return opts.validSeq[i++] ?? null;
      return opts.valid ?? null;
    },
    async loadLatest() {
      return opts.latest ?? null;
    },
    async save(fresh) {
      persisted.push(fresh);
      return fresh;
    },
  };
}

describe('tokenDuravelFromResponse', () => {
  it('maps a token response to an absolute ms-since-epoch expiry (−5s guard)', () => {
    expect(tokenDuravelFromResponse(RESP, NOW)).toEqual({
      access_token: 'AT2',
      refresh_token: 'RT2',
      token_type: 'bearer',
      scope: 'offline_access read write',
      expires_in: NOW + 21600 * 1000 - 5000,
      user_id: 7,
      expired: null,
    });
  });

  it('defaults scope to "" and user_id to null when ML omits them', () => {
    const t = tokenDuravelFromResponse(
      { access_token: 'A', token_type: 'bearer', expires_in: 100, refresh_token: 'R' },
      NOW,
    );
    expect(t.scope).toBe('');
    expect(t.user_id).toBeNull();
  });
});

describe('getOrRefreshAccessToken', () => {
  it('fast path: returns the newest valid token without refreshing', async () => {
    const refresh = vi.fn();
    const store = fakeStore({ valid: tok({ access_token: 'live' }) });
    const at = await getOrRefreshAccessToken(store, config, { now: NOW, refresh });
    expect(at).toBe('live');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes with the latest refresh_token and persists the rotated token', async () => {
    const refresh = vi.fn(async () => RESP);
    const store = fakeStore({
      valid: null,
      latest: tok({ refresh_token: 'RT-old', expires_in: NOW - 1000 }),
    });
    const at = await getOrRefreshAccessToken(store, config, { now: NOW, refresh });
    expect(refresh).toHaveBeenCalledWith(config, 'RT-old');
    expect(at).toBe('AT2');
    expect(store.persisted).toHaveLength(1);
    expect(store.persisted[0]!.refresh_token).toBe('RT2');
    expect(store.persisted[0]!.expires_in).toBe(NOW + 21600 * 1000 - 5000);
  });

  it('does not re-POST when a concurrent refresh already made the latest token valid', async () => {
    const refresh = vi.fn();
    const store = fakeStore({
      valid: null, // fast path missed it (raced)
      latest: tok({ access_token: 'other-fresh', expires_in: NOW + HOUR }),
    });
    const at = await getOrRefreshAccessToken(store, config, { now: NOW, refresh });
    expect(refresh).not.toHaveBeenCalled();
    expect(at).toBe('other-fresh');
  });

  it('throws reauth-required when there is no credential at all', async () => {
    const store = fakeStore({ valid: null, latest: null });
    await expect(getOrRefreshAccessToken(store, config, { now: NOW })).rejects.toBeInstanceOf(
      MercadoLivreReauthRequiredError,
    );
  });

  it('"one wins": on invalid_grant (lost the single-use race) it uses the winner\'s token', async () => {
    const refresh = vi.fn(async () => {
      throw new MercadoLivreReauthRequiredError('refresh_failed', 'refresh token already used');
    });
    const store = fakeStore({
      validSeq: [null, tok({ access_token: 'winner' })], // fast path null, then winner's token
      latest: tok({ refresh_token: 'RT-used', expires_in: NOW - 1000 }),
    });
    const at = await getOrRefreshAccessToken(store, config, { now: NOW, refresh });
    expect(at).toBe('winner');
  });

  it('re-reads after a transient HTTP error and uses the winner', async () => {
    const refresh = vi.fn(async () => {
      throw new MercadoLivreHttpError('rate limited', 429, {});
    });
    const store = fakeStore({
      validSeq: [null, tok({ access_token: 'winner2' })],
      latest: tok({ expires_in: NOW - 1000 }),
    });
    const at = await getOrRefreshAccessToken(store, config, { now: NOW, refresh });
    expect(at).toBe('winner2');
  });

  it('re-raises reauth-required when the refresh failed and no winner appeared', async () => {
    const refresh = vi.fn(async () => {
      throw new MercadoLivreReauthRequiredError('refresh_failed', 'dead');
    });
    const store = fakeStore({ validSeq: [null, null], latest: tok({ expires_in: NOW - 1000 }) });
    await expect(
      // `sleep` stubbed out: the loser fallback backs off before its second
      // re-read, and this path is the one that always reaches it.
      getOrRefreshAccessToken(store, config, { now: NOW, refresh, sleep: async () => undefined }),
    ).rejects.toBeInstanceOf(MercadoLivreReauthRequiredError);
  });

  /**
   * The loser's re-read races the winner's `save()`, and loses it more often
   * than not: ML rejects our used `refresh_token` faster than it mints and
   * rotates a pair for the winner. One immediate read is therefore not enough.
   */
  describe('loser fallback backoff', () => {
    it("re-reads again after the backoff when the winner's write lands late", async () => {
      const sleep = vi.fn(async () => undefined);
      const refresh = vi.fn(async () => {
        throw new MercadoLivreReauthRequiredError('refresh_failed', 'refresh token already used');
      });
      const store = fakeStore({
        // fast path null, immediate re-read still null (write in flight), then it lands
        validSeq: [null, null, tok({ access_token: 'late-winner' })],
        latest: tok({ refresh_token: 'RT-used', expires_in: NOW - 1000 }),
      });
      const at = await getOrRefreshAccessToken(store, config, { now: NOW, refresh, sleep });
      expect(at).toBe('late-winner');
      expect(sleep).toHaveBeenCalledExactlyOnceWith(LOSER_REREAD_DELAY_MS);
    });

    it('does not wait when the immediate re-read already finds the winner', async () => {
      const sleep = vi.fn(async () => undefined);
      const refresh = vi.fn(async () => {
        throw new MercadoLivreHttpError('rate limited', 429, {});
      });
      const store = fakeStore({
        validSeq: [null, tok({ access_token: 'winner' })],
        latest: tok({ expires_in: NOW - 1000 }),
      });
      const at = await getOrRefreshAccessToken(store, config, { now: NOW, refresh, sleep });
      expect(at).toBe('winner');
      expect(sleep).not.toHaveBeenCalled();
    });

    it('re-raises the ORIGINAL error after one backoff when both re-reads are empty', async () => {
      const sleep = vi.fn(async () => undefined);
      const dead = new MercadoLivreReauthRequiredError('refresh_failed', 'dead');
      const refresh = vi.fn(async () => {
        throw dead;
      });
      const store = fakeStore({
        validSeq: [null, null, null],
        latest: tok({ expires_in: NOW - 1000 }),
      });
      await expect(
        getOrRefreshAccessToken(store, config, { now: NOW, refresh, sleep }),
      ).rejects.toBe(dead);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(LOSER_REREAD_DELAY_MS);
    });
  });
});
