import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChartApi } from './sizeChartApi';

afterEach(() => vi.unstubAllGlobals());
describe('journal-owned chart transport', () => {
  it('does not automatically repost a chart or row after a lost response', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Lost response'));
    vi.stubGlobal('fetch', fetch);
    await expect(createChartApi('test').createSizeChart({})).rejects.toMatchObject({
      name: 'MercadoLivreNetworkError',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });
});
