import { afterEach, describe, expect, it, vi } from 'vitest';
import { buscarCnpj, cleanCnpj } from './consultaCnpj';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BRASILAPI_BODY = {
  razao_social: 'EMPRESA EXEMPLO LTDA',
  nome_fantasia: 'Exemplo',
  descricao_tipo_de_logradouro: 'AVENIDA',
  logradouro: 'PAULISTA',
  numero: '1000',
  complemento: 'SALA 1',
  bairro: 'BELA VISTA',
  cep: '01310100',
  municipio: 'SAO PAULO',
  uf: 'SP',
  codigo_municipio_ibge: 3550308,
};

describe('cleanCnpj', () => {
  it('strips punctuation to the 14-char wire format', () => {
    expect(cleanCnpj('11.222.333/0001-81')).toBe('11222333000181');
  });
});

describe('buscarCnpj', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps a BrasilAPI response to the cliente shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(BRASILAPI_BODY));
    // Accepts a formatted CNPJ; cleaned before the request.
    expect(await buscarCnpj('11.222.333/0001-81')).toEqual({
      nome: 'EMPRESA EXEMPLO LTDA',
      nomeFantasia: 'Exemplo',
      ie: null,
      uf: 'SP',
      endereco: {
        cep: '01310100',
        logradouro: 'AVENIDA PAULISTA',
        numero: '1000',
        complemento: 'SALA 1',
        bairro: 'BELA VISTA',
        cidade: 'SAO PAULO',
        estado: 'SP',
        codigoMunicipio: '3550308',
      },
    });
  });

  it('returns null for a short/malformed CNPJ without calling the API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await buscarCnpj('123')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null for an alphanumeric CNPJ (not queryable on BrasilAPI)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await buscarCnpj('AB222333000181')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null on a 404 (CNPJ not found)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ message: 'not found' }, 404));
    expect(await buscarCnpj('11222333000181')).toBeNull();
  });

  it('returns null on a non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 500));
    expect(await buscarCnpj('11222333000181')).toBeNull();
  });

  it('returns null when razão social is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ uf: 'SP' }));
    expect(await buscarCnpj('11222333000181')).toBeNull();
  });

  it('yields a null endereço when UF/cidade are absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ razao_social: 'SEM ENDERECO LTDA' }),
    );
    const data = await buscarCnpj('11222333000181');
    expect(data?.endereco).toBeNull();
    expect(data?.uf).toBe('');
  });

  it('propagates a network TypeError so the caller can narrow it', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(buscarCnpj('11222333000181')).rejects.toBeInstanceOf(TypeError);
  });

  it('propagates a malformed-JSON SyntaxError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<<not json>>', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(buscarCnpj('11222333000181')).rejects.toBeInstanceOf(SyntaxError);
  });
});
