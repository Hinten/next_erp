import { describe, expect, it } from 'vitest';

import { mockFetch } from '../_helpers/mockFetch';
import { createFreightHttpClient } from '../../src/http-client/client';
import {
  FreightAuthError,
  FreightLabelTerminalError,
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

  it('agencias GETs the service + sender location and returns the agencies', async () => {
    const body = { agencies: [{ id: 195, name: 'JADLOG CAXIAS DO SUL' }] };
    const fetchMock = mockFetch(async () => new Response(JSON.stringify(body), { status: 200 }));
    const out = await client(fetchMock).agencias('int-1', {
      service: 3,
      state: 'RS',
      city: 'Caxias do Sul',
    });
    expect(out.agencies[0]!.id).toBe(195);
    const u = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(u.pathname).toBe('/api/freight/melhor-envio/agencias');
    expect(u.searchParams.get('intFreteId')).toBe('int-1');
    expect(u.searchParams.get('service')).toBe('3');
    expect(u.searchParams.get('state')).toBe('RS');
    expect(u.searchParams.get('city')).toBe('Caxias do Sul');
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

  it('maps 409 ME_LABEL_TERMINAL → FreightLabelTerminalError (not reauth)', async () => {
    const body = { error: 'cancelada', code: 'ME_LABEL_TERMINAL', reason: 'canceled' };
    const fetchMock = mockFetch(async () => new Response(JSON.stringify(body), { status: 409 }));
    const err = await client(fetchMock)
      .comprar('int-1', 'ped-1', { service: 3 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreightLabelTerminalError);
    expect((err as FreightLabelTerminalError).reason).toBe('canceled');
  });
});

describe('FreightHttpClient label methods', () => {
  it('comprar POSTs the cart payload + pedido id and returns the bought label', async () => {
    const body = {
      printLabelId: 'label-1',
      printUrl: 'https://sandbox/imprimir/abc',
      tracking: 'ME123BR',
      estado: 'aguardandoPostagem',
    };
    const fetchMock = mockFetch(async () => new Response(JSON.stringify(body), { status: 200 }));
    const out = await client(fetchMock).comprar('int-1', 'ped-1', { service: 3 }, 'resume-1');

    expect(out.printLabelId).toBe('label-1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:3001/api/freight/melhor-envio/comprar');
    expect(JSON.parse(init?.body as string)).toEqual({
      intFreteId: 'int-1',
      pedidoId: 'ped-1',
      cartPayload: { service: 3 },
      printLabelId: 'resume-1',
    });
  });

  it('imprimir returns the label URL', async () => {
    const fetchMock = mockFetch(
      async () =>
        new Response(JSON.stringify({ url: 'https://sandbox/imprimir/abc' }), { status: 200 }),
    );
    const out = await client(fetchMock).imprimir('int-1', 'label-1');
    expect(out.url).toBe('https://sandbox/imprimir/abc');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:3001/api/freight/melhor-envio/imprimir');
  });

  it('rastrear returns the tracking payload', async () => {
    const body = { tracking: { 'label-1': { status: 'posted' } } };
    const fetchMock = mockFetch(async () => new Response(JSON.stringify(body), { status: 200 }));
    const out = await client(fetchMock).rastrear('int-1', 'label-1');
    expect(out.tracking).toEqual({ 'label-1': { status: 'posted' } });
  });
});
