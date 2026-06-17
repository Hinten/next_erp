import { afterEach, describe, expect, it, vi } from 'vitest';
import { buscarCep } from './viaCep';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('buscarCep', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps a ViaCEP response to the endereço shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        logradouro: 'Avenida Paulista',
        bairro: 'Bela Vista',
        localidade: 'São Paulo',
        uf: 'SP',
        ibge: '3550308',
      }),
    );
    // Accepts a formatted CEP; cleaned before the request.
    expect(await buscarCep('01310-100')).toEqual({
      logradouro: 'Avenida Paulista',
      bairro: 'Bela Vista',
      cidade: 'São Paulo',
      estado: 'SP',
      codigoMunicipio: '3550308',
    });
  });

  it('returns null for a malformed CEP without calling the API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await buscarCep('123')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when ViaCEP reports erro', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ erro: true }));
    expect(await buscarCep('00000000')).toBeNull();
  });

  it('returns null on a non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 400));
    expect(await buscarCep('01310100')).toBeNull();
  });
});
