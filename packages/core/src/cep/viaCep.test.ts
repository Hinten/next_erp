import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViaCepError, buscarCep, createViaCepClient } from './viaCep';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A `fetch` stub that builds a FRESH `Response` per call — a `Response` body is
 * single-read, so `mockResolvedValue(jsonResponse(...))` breaks the moment a
 * test exercises the cache by fetching twice.
 */
function fetchReturning(body: unknown, status = 200) {
  return vi.fn(() => Promise.resolve(jsonResponse(body, status)));
}

const PAULISTA = {
  logradouro: 'Avenida Paulista',
  bairro: 'Bela Vista',
  localidade: 'São Paulo',
  uf: 'SP',
  ibge: '3550308',
};

/**
 * Every test builds its OWN client so the memoization introduced in #785 stays
 * inside the test that exercises it — a shared cache across cases would make
 * one test's success answer another test's "not found".
 */
describe('createViaCepClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps a ViaCEP response to the endereço shape', async () => {
    const fetchStub = fetchReturning(PAULISTA);
    const client = createViaCepClient({ fetch: fetchStub });

    // Accepts a formatted CEP; cleaned before the request.
    expect(await client.buscarCep('01310-100')).toEqual({
      logradouro: 'Avenida Paulista',
      bairro: 'Bela Vista',
      cidade: 'São Paulo',
      estado: 'SP',
      codigoMunicipio: '3550308',
    });
    expect(fetchStub).toHaveBeenCalledWith(
      'https://viacep.com.br/ws/01310100/json/',
      expect.anything(),
    );
  });

  it('returns null for a malformed CEP without calling the API', async () => {
    const fetchStub = vi.fn();
    const client = createViaCepClient({ fetch: fetchStub });

    expect(await client.buscarCep('123')).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('returns null when ViaCEP reports erro', async () => {
    const fetchStub = fetchReturning({ erro: true });
    const client = createViaCepClient({ fetch: fetchStub });

    expect(await client.buscarCep('00000000')).toBeNull();
  });

  it('returns null on a non-OK response', async () => {
    const fetchStub = fetchReturning({}, 400);
    const client = createViaCepClient({ fetch: fetchStub });

    expect(await client.buscarCep('01310100')).toBeNull();
  });

  it('honours a custom baseUrl', async () => {
    const fetchStub = fetchReturning(PAULISTA);
    const client = createViaCepClient({ fetch: fetchStub, baseUrl: 'http://localhost:9999/ws' });

    await client.buscarCep('01310100');
    expect(fetchStub).toHaveBeenCalledWith(
      'http://localhost:9999/ws/01310100/json/',
      expect.anything(),
    );
  });

  describe('failures', () => {
    it('wraps a network failure in ViaCepError, preserving the cause', async () => {
      const cause = new TypeError('fetch failed');
      const client = createViaCepClient({ fetch: vi.fn().mockRejectedValue(cause) });

      const err = await client.buscarCep('01310100').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ViaCepError);
      expect((err as ViaCepError).cep).toBe('01310100');
      expect((err as ViaCepError).cause).toBe(cause);
    });

    it('wraps a timeout in ViaCepError', async () => {
      // `AbortSignal.timeout` rejects with a DOMException, which no caller
      // would think to narrow on — that is why ViaCepError exists.
      const cause = new DOMException('The operation was aborted.', 'TimeoutError');
      const client = createViaCepClient({ fetch: vi.fn().mockRejectedValue(cause) });

      const err = await client.buscarCep('01310100').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ViaCepError);
      expect((err as ViaCepError).cause).toBe(cause);
    });

    it('wraps malformed JSON in ViaCepError', async () => {
      const fetchStub = vi
        .fn()
        .mockResolvedValue(new Response('<html>nope</html>', { status: 200 }));
      const client = createViaCepClient({ fetch: fetchStub });

      await expect(client.buscarCep('01310100')).rejects.toBeInstanceOf(ViaCepError);
    });

    it('rethrows anything that is not a transport failure', async () => {
      const boom = new RangeError('bug in caller-supplied fetch');
      const client = createViaCepClient({ fetch: vi.fn().mockRejectedValue(boom) });

      await expect(client.buscarCep('01310100')).rejects.toBe(boom);
    });

    it('does not memoize a non-OK response', async () => {
      const fetchStub = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({}, 503))
        .mockResolvedValueOnce(jsonResponse(PAULISTA));
      const client = createViaCepClient({ fetch: fetchStub });

      // A 429/5xx is transient; caching it would poison the process.
      expect(await client.buscarCep('01310100')).toBeNull();
      expect(await client.buscarCep('01310100')).not.toBeNull();
      expect(fetchStub).toHaveBeenCalledTimes(2);
    });
  });

  describe('memoization', () => {
    it('serves a repeated CEP from the cache', async () => {
      const fetchStub = fetchReturning(PAULISTA);
      const client = createViaCepClient({ fetch: fetchStub });

      const first = await client.buscarCep('01310100');
      const second = await client.buscarCep('01310-100');

      expect(second).toEqual(first);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    });

    it('memoizes a definitive not-found', async () => {
      const fetchStub = fetchReturning({ erro: true });
      const client = createViaCepClient({ fetch: fetchStub });

      expect(await client.buscarCep('00000000')).toBeNull();
      expect(await client.buscarCep('00000000')).toBeNull();
      expect(fetchStub).toHaveBeenCalledTimes(1);
    });

    it('collapses concurrent lookups of the same CEP into one request', async () => {
      const fetchStub = fetchReturning(PAULISTA);
      const client = createViaCepClient({ fetch: fetchStub });

      const [a, b, c] = await Promise.all([
        client.buscarCep('01310100'),
        client.buscarCep('01310100'),
        client.buscarCep('01310100'),
      ]);

      expect(a).toEqual(b);
      expect(b).toEqual(c);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    });

    it('does not leave a rejected lookup in the in-flight map', async () => {
      const fetchStub = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse(PAULISTA));
      const client = createViaCepClient({ fetch: fetchStub });

      await expect(client.buscarCep('01310100')).rejects.toBeInstanceOf(ViaCepError);
      expect(await client.buscarCep('01310100')).not.toBeNull();
      expect(fetchStub).toHaveBeenCalledTimes(2);
    });

    it('evicts the oldest entry once cacheMax is reached', async () => {
      const fetchStub = fetchReturning(PAULISTA);
      const client = createViaCepClient({ fetch: fetchStub, cacheMax: 1 });

      await client.buscarCep('01310100');
      await client.buscarCep('20040002'); // evicts 01310100
      await client.buscarCep('01310100'); // refetched

      expect(fetchStub).toHaveBeenCalledTimes(3);
    });

    it('cacheMax 0 disables memoization', async () => {
      const fetchStub = fetchReturning(PAULISTA);
      const client = createViaCepClient({ fetch: fetchStub, cacheMax: 0 });

      await client.buscarCep('01310100');
      await client.buscarCep('01310100');

      expect(fetchStub).toHaveBeenCalledTimes(2);
    });
  });
});

describe('buscarCep (default client)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves through globalThis.fetch', async () => {
    // The default client resolves `globalThis.fetch` per request, so a spy
    // installed after the client was created is still honoured.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ ...PAULISTA, ibge: '3304557', localidade: 'Rio de Janeiro', uf: 'RJ' }),
    );

    // A CEP used by no other test — the default client's cache is process-wide.
    expect(await buscarCep('20040-002')).toMatchObject({
      cidade: 'Rio de Janeiro',
      estado: 'RJ',
      codigoMunicipio: '3304557',
    });
  });
});
