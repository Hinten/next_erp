/**
 * Route tests for GET /api/nfe/status-servico. vi.mock auth + runtime + the
 * library's consultarStatusServico to isolate the route contract:
 *   - 401 on auth
 *   - 400 on a bad target
 *   - 200 with {target, authorizer, cStat, category} for normal + svc
 *   - the svc target hits the SVC URL with the issuer's cUF
 *   - 502 when SEFAZ is unreachable (NFeTransportError)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/auth')>();
  return { ...actual, verifyCaller: vi.fn() };
});
vi.mock('@/lib/nfe/runtime', () => ({ getNFeRuntime: vi.fn() }));
vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  return { ...actual, consultarStatusServico: vi.fn() };
});

import { NextResponse } from 'next/server';

import { NFeTransportError, consultarStatusServico } from '@delfrance/integrations-nfe';

import { verifyCaller } from '@/lib/nfe/auth';
import { getNFeRuntime, type NFeRuntime } from '@/lib/nfe/runtime';

import { GET } from '../../../../../app/api/nfe/status-servico/route';

function req(qs = ''): Request {
  return new Request(`http://localhost/api/nfe/status-servico${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: { authorization: 'Bearer t' },
  });
}

function fakeRuntime(): NFeRuntime {
  return {
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
    svc: (authorizer) => ({
      endpoints: {
        NfeAutorizacao: `https://example/${authorizer}/aut`,
        NfeRetAutorizacao: `https://example/${authorizer}/ret`,
        NfeConsultaProtocolo: `https://example/${authorizer}/cons`,
        NfeStatusServico: `https://example/${authorizer}/sta`,
        RecepcaoEvento: `https://example/${authorizer}/rec`,
      },
      agent: {} as never,
    }),
    an: () => ({
      endpoints: { RecepcaoEvento: 'https://example/an/rec' },
      agent: {} as never,
    }),
    diagnostics: { subjectCommonName: 'TEST', notAfter: '2027-01-01', chainSource: 'x' },
  };
}

const RET_107 = {
  tpAmb: '2',
  verAplic: 'SP',
  cStat: '107',
  xMotivo: 'Serviço em Operação',
  cUF: '35',
  dhRecbto: '2026-06-10T10:00:00-03:00',
  tMed: '1',
  versao: '4.00',
} as never;

beforeEach(() => {
  vi.mocked(verifyCaller).mockResolvedValue({ caller: { uid: 'u-1', permissions: '0xff' } });
  vi.mocked(getNFeRuntime).mockReturnValue(fakeRuntime());
  vi.mocked(consultarStatusServico).mockResolvedValue(RET_107);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/nfe/status-servico', () => {
  it('401 when auth fails', async () => {
    vi.mocked(verifyCaller).mockResolvedValue({
      error: NextResponse.json({ error: 'no token' }, { status: 401 }),
    });
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('400 on an unknown target', async () => {
    const res = await GET(req('target=banana'));
    expect(res.status).toBe(400);
  });

  it('200 normal → home SEFAZ status URL with the issuer cUF', async () => {
    const res = await GET(req('target=normal'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.target).toBe('normal');
    expect(body.authorizer).toBe('sefaz');
    expect(body.cStat).toBe('107');
    expect(body.category).toBe('servico-em-operacao');
    expect(vi.mocked(consultarStatusServico)).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example/sefaz/sta' }),
      { cUF: '35' },
    );
  });

  it("200 svc → the UF's SVC status URL (SP → svc-an), still the issuer cUF", async () => {
    const res = await GET(req('target=svc'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.target).toBe('svc');
    expect(body.authorizer).toBe('svc-an');
    expect(vi.mocked(consultarStatusServico)).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example/svc-an/sta' }),
      { cUF: '35' },
    );
  });

  it('classifies 113/114 (SVC em desativação/desabilitada) as servico-paralisado', async () => {
    vi.mocked(consultarStatusServico).mockResolvedValue({
      ...(RET_107 as Record<string, unknown>),
      cStat: '114',
      xMotivo: 'SVC desabilitada pela SEFAZ de origem',
    } as never);
    const res = await GET(req('target=svc'));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.cStat).toBe('114');
    expect(body.category).toBe('servico-paralisado');
  });

  it('502 when the authorizer is unreachable (NFeTransportError)', async () => {
    vi.mocked(consultarStatusServico).mockRejectedValue(
      new NFeTransportError('connect ETIMEDOUT 1.2.3.4:443'),
    );
    const res = await GET(req('target=normal'));
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('NFeTransportError');
  });
});
