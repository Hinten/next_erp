import { describe, expect, it, vi } from 'vitest';
import { probeMissedFeeds } from './missedFeedsProbe';

describe('missed-feeds provider probe', () => {
  it('compares all three query shapes and emits only sanitized summaries', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ topic: 'orders_v2', request: { url: 'SECRET_CALLBACK' } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'site_id required', secret: 'SECRET_ERROR' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] })));
    const token = vi.fn(async () => 'SECRET_TOKEN');
    const rows = await probeMissedFeeds('42', token, 'MLB', fetchMock);
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map((url) => url.searchParams.get('topic'))).toEqual([null, 'items', 'items']);
    expect(urls.map((url) => url.searchParams.get('site_id'))).toEqual([null, null, 'MLB']);
    expect(rows.map((row) => row.status)).toEqual([200, 400, 200]);
    expect(rows[0]).toMatchObject({ count: 1, topics: { orders_v2: 1 } });
    expect(rows[2]).toMatchObject({ shape: 'messages-array', count: 0 });
    expect(token).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    for (const [, init] of fetchMock.mock.calls) expect(init?.headers).toEqual({ Authorization: 'Bearer SECRET_TOKEN' });
  });
  it('counts prototype-shaped topic names as numeric own properties', async () => {
    const rows = await probeMissedFeeds('42', async () => 'token', 'MLB',
      vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ messages: [{ topic: 'constructor' }, { topic: 'constructor' }] }))));
    expect(rows[0]?.topics.constructor).toBe(2);
    expect(Object.hasOwn(rows[0]!.topics, 'constructor')).toBe(true);
  });
  it.each([
    ['<html>private content</html>', 'invalid-json'],
    ['null', 'non-object'],
    ['{}', 'missing-messages'],
    ['{"messages":{}}', 'invalid-messages'],
  ])('does not turn %s into a healthy empty feed', async (body, shape) => {
    const rows = await probeMissedFeeds('42', async () => 'token', 'MLB',
      vi.fn<typeof fetch>(async () => new Response(body)));
    expect(rows.every((row) => row.shape === shape && row.count === null)).toBe(true);
  });
});
