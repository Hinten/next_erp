import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NFeHttpError,
  NFeNetworkError,
  type NFeConsultaCadastroResult,
  type NFeHttpClient,
} from '@delfrance/integrations-nfe/http-provider';
import { resolveCnpj } from './resolveCnpj';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Fixture CNPJs only — never a real one.
const CNPJ = '14200166000187';

const BRASILAPI_BODY = {
  razao_social: 'EMPRESA EXEMPLO LTDA',
  nome_fantasia: 'Exemplo',
  descricao_tipo_de_logradouro: 'AVENIDA',
  logradouro: 'PAULISTA',
  numero: '1000',
  bairro: 'BELA VISTA',
  cep: '01310100',
  municipio: 'SAO PAULO',
  uf: 'SP',
  codigo_municipio_ibge: 3550308,
};

/** A fake `NFeHttpClient` exposing only the method `resolveCnpj` touches. */
function fakeNfe(consultaCadastro: NFeHttpClient['consultaCadastro']): NFeHttpClient {
  return { consultaCadastro } as unknown as NFeHttpClient;
}

/** Minimal `NFeConsultaCadastroResult` with the given infCad entries. */
function cadResult(
  partial: Partial<NFeConsultaCadastroResult> & Pick<NFeConsultaCadastroResult, 'infCad'>,
): NFeConsultaCadastroResult {
  return {
    supported: true,
    uf: 'SP',
    cStat: '111',
    xMotivo: 'Consulta cadastro com uma ocorrência',
    ...partial,
  };
}

function infCad(ie: string, situacao: string): NFeConsultaCadastroResult['infCad'][number] {
  return {
    ie,
    cnpj: CNPJ,
    cpf: null,
    uf: 'SP',
    situacao,
    razaoSocial: 'EMPRESA EXEMPLO LTDA',
    ender: null,
  };
}

describe('resolveCnpj', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fills nome from the public API and the authoritative IE from SEFAZ', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(BRASILAPI_BODY));
    const consultaCadastro = vi
      .fn()
      .mockResolvedValue(cadResult({ infCad: [infCad('111111111', '1')] }));

    const outcome = await resolveCnpj(CNPJ, fakeNfe(consultaCadastro), 'filial-1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.nome).toBe('EMPRESA EXEMPLO LTDA');
    expect(outcome.data.ie).toBe('111111111');
    expect(outcome.data.sefazNote).toBeNull();
    expect(outcome.data.endereco?.estado).toBe('SP');
    // Queries SEFAZ with the clean CNPJ, the public UF, and the filial id.
    expect(consultaCadastro).toHaveBeenCalledWith(CNPJ, 'SP', 'filial-1');
  });

  it('prefers the habilitada (situacao "1") entry among several inscrições', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(BRASILAPI_BODY));
    const consultaCadastro = vi
      .fn()
      .mockResolvedValue(
        cadResult({ infCad: [infCad('000-baixada', '0'), infCad('999-ativa', '1')] }),
      );

    const outcome = await resolveCnpj(CNPJ, fakeNfe(consultaCadastro), 'filial-1');

    expect(outcome.ok && outcome.data.ie).toBe('999-ativa');
  });

  it('cleans a formatted CNPJ before both lookups', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(BRASILAPI_BODY));
    const consultaCadastro = vi.fn().mockResolvedValue(cadResult({ infCad: [infCad('1', '1')] }));

    await resolveCnpj('14.200.166/0001-87', fakeNfe(consultaCadastro), 'filial-1');

    expect(fetchSpy).toHaveBeenCalledWith(`https://brasilapi.com.br/api/cnpj/v1/${CNPJ}`);
    expect(consultaCadastro).toHaveBeenCalledWith(CNPJ, 'SP', 'filial-1');
  });

  it('skips the SEFAZ leg when no nfe client is available (ie falls back to public)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(BRASILAPI_BODY));

    const outcome = await resolveCnpj(CNPJ, null, 'filial-1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // BrasilAPI never returns an IE → public fallback is null, no SEFAZ note.
    expect(outcome.data.ie).toBeNull();
    expect(outcome.data.sefazNote).toBeNull();
  });

  it('skips the SEFAZ leg when no filial id is available', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(BRASILAPI_BODY));
    const consultaCadastro = vi.fn();

    const outcome = await resolveCnpj(CNPJ, fakeNfe(consultaCadastro), undefined);

    expect(outcome.ok && outcome.data.ie).toBeNull();
    expect(consultaCadastro).not.toHaveBeenCalled();
  });

  it('reports a sefazNote with the cStat when SEFAZ returns no IE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(BRASILAPI_BODY));
    const consultaCadastro = vi
      .fn()
      .mockResolvedValue(
        cadResult({ cStat: '258', xMotivo: 'Rejeição: CNPJ não habilitado', infCad: [] }),
      );

    const outcome = await resolveCnpj(CNPJ, fakeNfe(consultaCadastro), 'filial-1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.ie).toBeNull();
    expect(outcome.data.sefazNote).toBe('SEFAZ 258: Rejeição: CNPJ não habilitado');
  });

  it('reports a sefazNote when the UF does not support Consulta Cadastro', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(BRASILAPI_BODY));
    const consultaCadastro = vi.fn().mockResolvedValue(
      cadResult({
        supported: false,
        cStat: null,
        xMotivo: 'UF não oferece consulta cadastro',
        infCad: [],
      }),
    );

    const outcome = await resolveCnpj(CNPJ, fakeNfe(consultaCadastro), 'filial-1');

    expect(outcome.ok && outcome.data.sefazNote).toBe('UF não oferece consulta cadastro');
  });

  it('reports a sefazNote when SEFAZ is degraded (transport blip)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(BRASILAPI_BODY));
    const consultaCadastro = vi
      .fn()
      .mockResolvedValue(cadResult({ degraded: true, cStat: null, xMotivo: null, infCad: [] }));

    const outcome = await resolveCnpj(CNPJ, fakeNfe(consultaCadastro), 'filial-1');

    expect(outcome.ok && outcome.data.sefazNote).toBe('SEFAZ indisponível no momento');
  });

  it('swallows a typed NFe error and falls back to the public IE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(BRASILAPI_BODY));
    const consultaCadastro = vi.fn().mockRejectedValue(new NFeNetworkError('connection reset'));

    const outcome = await resolveCnpj(CNPJ, fakeNfe(consultaCadastro), 'filial-1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.ie).toBeNull();
    expect(outcome.data.sefazNote).toBe('não foi possível consultar a SEFAZ');
  });

  it('swallows an NFeHttpError from the SEFAZ leg', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(BRASILAPI_BODY));
    const consultaCadastro = vi.fn().mockRejectedValue(new NFeHttpError('boom', 500, null));

    const outcome = await resolveCnpj(CNPJ, fakeNfe(consultaCadastro), 'filial-1');

    expect(outcome.ok && outcome.data.sefazNote).toBe('não foi possível consultar a SEFAZ');
  });

  it('rethrows a non-NFe error from the SEFAZ leg (CLAUDE.md rule 6)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(BRASILAPI_BODY));
    const consultaCadastro = vi.fn().mockRejectedValue(new RangeError('unexpected'));

    await expect(resolveCnpj(CNPJ, fakeNfe(consultaCadastro), 'filial-1')).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it('returns not-found when the public API has no match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ message: 'not found' }, 404));
    expect(await resolveCnpj(CNPJ, null)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('returns network on a fetch TypeError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await resolveCnpj(CNPJ, null)).toEqual({ ok: false, reason: 'network' });
  });

  it('returns invalid-response on malformed JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<<not json>>', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(await resolveCnpj(CNPJ, null)).toEqual({ ok: false, reason: 'invalid-response' });
  });
});
