import { describe, expect, it } from 'vitest';

import { mockFetch } from '../_helpers/mockFetch';
import { createFreightHttpClient } from '../../src/http-client/client';
import {
  FreightAuthError,
  FreightNetworkError,
  FreightNotFoundError,
  FreightReauthRequiredError,
  FreightServerError,
  FreightValidationError,
} from '../../src/http-client/errors';

function client(fetchImpl: typeof globalThis.fetch) {
  return createFreightHttpClient({
    baseUrl: 'http://localhost:3001/',
    getAuthToken: async () => 'id-token',
    fetch: fetchImpl,
  });
}

describe('FreightHttpClient happy paths', () => {
  it('oauthStart GETs with Bearer and returns the authorize URL', async () => {
    const fetchMock = mockFetch(
      async () =>
        new Response(JSON.stringify({ authorizeUrl: 'https://sandbox/oauth/authorize?x' }), {
          status: 200,
        }),
    );
    const out = await client(fetchMock).oauthStart('int-1');
    expect(out.authorizeUrl).toContain('/oauth/authorize');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:3001/api/freight/melhor-envio/oauth/start?intFreteId=int-1');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer id-token');
  });

  it('calculate POSTs { intFreteId, ...req }', async () => {
    const fetchMock = mockFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    await client(fetchMock).calculate('int-1', {
      from: { postal_code: '01001000' },
      to: { postal_code: '20040002' },
      package: { width: 20, height: 20, length: 20, weight: 1 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:3001/api/freight/melhor-envio/calculate');
    const sent = JSON.parse(init?.body as string);
    expect(sent.intFreteId).toBe('int-1');
    expect(sent.from.postal_code).toBe('01001000');
  });

  it('conta returns connection status', async () => {
    const body = { connected: true, me: { firstname: 'Magno' }, balance: { balance: 10 } };
    const fetchMock = mockFetch(async () => new Response(JSON.stringify(body), { status: 200 }));
    const out = await client(fetchMock).conta('int-1');
    expect(out.connected).toBe(true);
    expect(out.me?.firstname).toBe('Magno');
    expect(out.balance?.balance).toBe(10);
  });
});

describe('FreightHttpClient error mapping', () => {
  const cases: Array<[number, unknown, new (...a: never[]) => Error]> = [
    [401, { error: 'sem token' }, FreightAuthError],
    [403, { error: 'sem permissão' }, FreightAuthError],
    [404, { error: 'não encontrado' }, FreightNotFoundError],
    [409, { error: 'reconecte', code: 'ME_REAUTH' }, FreightReauthRequiredError],
    [500, { error: 'boom' }, FreightServerError],
  ];

  for (const [status, body, Ctor] of cases) {
    it(`maps ${status} → ${Ctor.name}`, async () => {
      const fetchMock = mockFetch(async () => new Response(JSON.stringify(body), { status }));
      const err = await client(fetchMock)
        .conta('int-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Ctor);
    });
  }

  it('maps 422 → FreightValidationError carrying the errors map', async () => {
    const body = { error: 'inválido', errors: { 'to.postal_code': ['obrigatório'] } };
    const fetchMock = mockFetch(async () => new Response(JSON.stringify(body), { status: 422 }));
    const err = await client(fetchMock)
      .calculate('int-1', { from: { postal_code: 'a' }, to: { postal_code: 'b' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreightValidationError);
    expect((err as FreightValidationError).errors['to.postal_code']).toEqual(['obrigatório']);
  });

  it('wraps a fetch network failure in FreightNetworkError', async () => {
    const fetchMock = mockFetch(async () => {
      throw new TypeError('failed to fetch');
    });
    const err = await client(fetchMock)
      .conta('int-1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreightNetworkError);
  });
});
