import { afterEach, describe, expect, it, vi } from 'vitest';

import { fabricaApiPadrao } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fabricaApiPadrao', () => {
  it('builds a client that authenticates with the token it was given', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 4242 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const me = await fabricaApiPadrao('TOKEN-DA-CONTA').getMe();

    expect(me.id).toBe(4242);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/users/me');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer TOKEN-DA-CONTA' });
  });

  it('gives every account its own client, with its own token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fabricaApiPadrao('A').getMe();
    await fabricaApiPadrao('B').getMe();

    const tokens = fetchMock.mock.calls.map((chamada) => {
      const [, init] = chamada as unknown as [string, RequestInit];
      return (init.headers as Record<string, string>).Authorization;
    });
    expect(tokens).toEqual(['Bearer A', 'Bearer B']);
  });
});
