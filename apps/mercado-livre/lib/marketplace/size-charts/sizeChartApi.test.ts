import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChartApi } from './sizeChartApi';

afterEach(() => vi.unstubAllGlobals());
describe('journal-owned chart transport', () => {
  it('does not automatically repost a chart or row after a lost response', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Lost response'));
    vi.stubGlobal('fetch', fetch);
    await expect(
      createChartApi({ getAccessToken: async () => 'test' }).createSizeChart({}),
    ).rejects.toMatchObject({
      name: 'MercadoLivreNetworkError',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it('resolves a fresh access token for each operation in a long-running chart job', async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const renewToken = vi.fn(async () => 'renewed-token');
      const getAccessToken = vi.fn(async () =>
        Date.now() < startedAt + 60_000 ? 'initial-token' : renewToken(),
      );
      const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
        Response.json({}),
      );
      vi.stubGlobal('fetch', fetch);
      const api = createChartApi({ getAccessToken });

      await api.deleteSizeChart('501');
      vi.setSystemTime(startedAt + 60_000);
      await api.deleteSizeChart('502');

      expect(getAccessToken).toHaveBeenCalledTimes(2);
      expect(renewToken).toHaveBeenCalledTimes(1);
      expect(
        fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get('authorization')),
      ).toEqual(['Bearer initial-token', 'Bearer renewed-token']);
    } finally {
      vi.useRealTimers();
    }
  });
});
