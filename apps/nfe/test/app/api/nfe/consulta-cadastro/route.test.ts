/**
 * Route tests for POST /api/nfe/consulta-cadastro. vi.mock auth + runtime +
 * resolveFilialRuntime + the library's consultarCadastro / getConsultaCadastroEndpoint
 * to isolate the route contract:
 *   - 401 on auth
 *   - 400 on a malformed cnpj / uf / missing filialId
 *   - 200 supported:false when the UF has no consulta-cadastro endpoint
 *   - 200 supported:false on a cross-UF request (uf !== runtime.uf)
 *   - 422 when the filial has no cert (resolveFilialRuntime → NFeCertError)
 *   - 200 supported:true with friendly-keyed infCad (xNome→razaoSocial, xLgr→logradouro, …)
 *   - 200 supported:true infCad:[] on a no-match cStat (259)
 *   - 200 degraded on a transport error (NFeTransportError), never 5xx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/auth')>();
  return { ...actual, verifyCaller: vi.fn() };
});
vi.mock('@/lib/nfe/runtime', () => ({ getNFeRuntime: vi.fn() }));
vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: vi.fn(() => ({})) }));
vi.mock('@/lib/nfe/filial-cert', () => ({ resolveFilialRuntime: vi.fn() }));
vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  return {
    ...actual,
    consultarCadastro: vi.fn(),
    getConsultaCadastroEndpoint: vi.fn(),
  };
});

import { NextResponse } from 'next/server';

import {
  NFeCertError,
  NFeTransportError,
  consultarCadastro,
  getConsultaCadastroEndpoint,
  type ConsultaCadastroResult,
} from '@delfrance/integrations-nfe';

import { verifyCaller } from '@/lib/nfe/auth';
import { resolveFilialRuntime } from '@/lib/nfe/filial-cert';
import { getNFeRuntime, type NFeBaseRuntime, type NFeRuntime } from '@/lib/nfe/runtime';

import { POST } from '../../../../../app/api/nfe/consulta-cadastro/route';

const FILIAL = 'F-1';
const CNPJ = '14200166000187';
const ENDPOINT = 'https://homologacao.nfe.fazenda.sp.gov.br/ws/cadconsultacadastro4.asmx';

// POST + JSON body — the CNPJ is kept out of the URL (logs/proxies/history).
function req(body: Record<string, unknown> = { cnpj: CNPJ, uf: 'SP', filialId: FILIAL }): Request {
  return new Request('http://localhost/api/nfe/consulta-cadastro', {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function fakeRuntime(): NFeRuntime & NFeBaseRuntime {
  const rt: NFeRuntime = {
    cert: {} as never,
    agent: {} as never,
    ambiente: 'homologacao',
    uf: 'SP',
    tpAmb: '2',
    endpoints: {
      NfeAutorizacao: 'https://example/sefaz/aut',
      NfeRetAutorizacao: 'https://example/sefaz/ret',
      NfeConsultaProtocolo: 'https://example/sefaz/cons',
      NfeStatusServico: 'https://example/sefaz/sta',
      NfeInutilizacao: 'https://example/sefaz/inu',
      RecepcaoEvento: 'https://example/sefaz/rec',
    },
    svc: () => ({ endpoints: {} as never, agent: {} as never }),
    an: () => ({ endpoints: { RecepcaoEvento: 'https://example/an/rec' }, agent: {} as never }),
    diagnostics: { subjectCommonName: 'TEST', notAfter: '2027-01-01', chainSource: 'x' },
  };
  return { ...rt, envRuntime: () => rt };
}

const RET_111: ConsultaCadastroResult = {
  cStat: '111',
  xMotivo: 'Consulta cadastro com uma ocorrência',
  uf: 'SP',
  infCad: [
    {
      IE: '111111111111',
      CNPJ,
      CPF: null,
      UF: 'SP',
      cSit: '1',
      indCredNFe: '1',
      indCredNFCe: '0',
      xNome: 'EMPRESA TESTE LTDA',
      ender: {
        xLgr: 'RUA DAS FLORES',
        nro: '100',
        xCpl: 'SALA 2',
        xBairro: 'CENTRO',
        cMun: '3550308',
        xMun: 'SAO PAULO',
        CEP: '01001000',
      },
    },
  ],
};

const RET_259: ConsultaCadastroResult = {
  cStat: '259',
  xMotivo: 'CNPJ não consta na base de dados da SEFAZ',
  uf: 'SP',
  infCad: [],
};

beforeEach(() => {
  vi.mocked(verifyCaller).mockResolvedValue({ caller: { uid: 'u-1', permissions: '0xff' } });
  vi.mocked(getNFeRuntime).mockReturnValue(fakeRuntime());
  vi.mocked(resolveFilialRuntime).mockResolvedValue(fakeRuntime());
  vi.mocked(getConsultaCadastroEndpoint).mockReturnValue(ENDPOINT);
  vi.mocked(consultarCadastro).mockResolvedValue(RET_111);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/nfe/consulta-cadastro', () => {
  it('401 when auth fails', async () => {
    vi.mocked(verifyCaller).mockResolvedValue({
      error: NextResponse.json({ error: 'no token' }, { status: 401 }),
    });
    const res = await POST(req());
    expect(res.status).toBe(401);
  });

  it('400 on a malformed cnpj', async () => {
    const res = await POST(req({ cnpj: '123', uf: 'SP', filialId: FILIAL }));
    expect(res.status).toBe(400);
  });

  it('400 when filialId is missing', async () => {
    const res = await POST(req({ cnpj: CNPJ, uf: 'SP' }));
    expect(res.status).toBe(400);
  });

  it('400 on a non-letter uf', async () => {
    const res = await POST(req({ cnpj: CNPJ, uf: 'S1', filialId: FILIAL }));
    expect(res.status).toBe(400);
  });

  it('200 supported:false when the UF has no consulta-cadastro endpoint', async () => {
    vi.mocked(getConsultaCadastroEndpoint).mockReturnValue(null);
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.supported).toBe(false);
    expect(body.cStat).toBeNull();
    expect(body.xMotivo).toBe('UF não oferece Consulta Cadastro');
    expect(body.infCad).toEqual([]);
    // Never reached the SEFAZ call.
    expect(vi.mocked(consultarCadastro)).not.toHaveBeenCalled();
  });

  it('200 supported:false on a cross-UF request (uf !== runtime uf)', async () => {
    const res = await POST(req({ cnpj: CNPJ, uf: 'RJ', filialId: FILIAL }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.supported).toBe(false);
    expect(body.xMotivo).toBe('Consulta Cadastro disponível apenas para a UF da filial');
    expect(vi.mocked(consultarCadastro)).not.toHaveBeenCalled();
  });

  it('422 when the filial has no cert (resolveFilialRuntime → NFeCertError)', async () => {
    vi.mocked(resolveFilialRuntime).mockRejectedValue(
      new NFeCertError('Filial sem certificado digital cadastrado.'),
    );
    const res = await POST(req());
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('NFeCertError');
  });

  it('200 supported:true with friendly-keyed infCad on cStat 111', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.supported).toBe(true);
    expect(body.uf).toBe('SP');
    expect(body.cStat).toBe('111');

    const infCad = body.infCad as Array<Record<string, unknown>>;
    expect(infCad).toHaveLength(1);
    const cad = infCad[0]!;
    // Friendly keys — the browser never sees raw SEFAZ casing.
    expect(cad.ie).toBe('111111111111');
    expect(cad.razaoSocial).toBe('EMPRESA TESTE LTDA');
    expect(cad.situacao).toBe('1');
    expect(cad.cnpj).toBe(CNPJ);
    expect(cad.cpf).toBeNull();
    expect('xNome' in cad).toBe(false);
    expect('cSit' in cad).toBe(false);

    const ender = cad.ender as Record<string, unknown>;
    expect(ender.logradouro).toBe('RUA DAS FLORES');
    expect(ender.numero).toBe('100');
    expect(ender.complemento).toBe('SALA 2');
    expect(ender.bairro).toBe('CENTRO');
    expect(ender.codigoMunicipio).toBe('3550308');
    expect(ender.municipio).toBe('SAO PAULO');
    expect(ender.cep).toBe('01001000');

    // The lookup signs with the named filial's runtime, hitting the UF endpoint.
    expect(vi.mocked(resolveFilialRuntime)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      FILIAL,
    );
    expect(vi.mocked(consultarCadastro)).toHaveBeenCalledWith(
      expect.objectContaining({ url: ENDPOINT }),
      { uf: 'SP', cnpj: CNPJ },
    );
  });

  it('200 supported:true with empty infCad on a no-match cStat (259)', async () => {
    vi.mocked(consultarCadastro).mockResolvedValue(RET_259);
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.supported).toBe(true);
    expect(body.cStat).toBe('259');
    expect(body.infCad).toEqual([]);
  });

  it('200 degraded (never 5xx) on a transport error', async () => {
    vi.mocked(consultarCadastro).mockRejectedValue(
      new NFeTransportError('connect ETIMEDOUT 1.2.3.4:443'),
    );
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.supported).toBe(true);
    expect(body.degraded).toBe(true);
    expect(body.cStat).toBeNull();
    expect(body.xMotivo).toBe('SEFAZ inacessível');
    expect(body.infCad).toEqual([]);
  });

  it('500 on a genuine bug (parse/our-XML error)', async () => {
    vi.mocked(consultarCadastro).mockRejectedValue(new Error('retConsCad missing <infCons>'));
    const res = await POST(req());
    expect(res.status).toBe(500);
  });
});
