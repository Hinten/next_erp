/**
 * Route tests for GET /api/nfe/consultar?chave=<44>. vi.mock auth + runtime +
 * resolveFilialRuntimeByCnpj + the library's consultarSituacaoNFe to isolate
 * the route contract:
 *   - 401 on auth
 *   - 400 on a malformed chave
 *   - 422 when no filial owns the chave's CNPJ (resolveFilialRuntimeByCnpj → NFeCertError)
 *   - 200 with the flattened {chave, cStat, xMotivo, nProt}
 *   - the consulta resolves the signing cert from the chave's emit CNPJ (positions 6–20)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/auth')>();
  return { ...actual, verifyCaller: vi.fn() };
});
vi.mock('@/lib/nfe/runtime', () => ({ getNFeRuntime: vi.fn() }));
vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: vi.fn(() => ({})) }));
vi.mock('@/lib/nfe/filial-cert', () => ({ resolveFilialRuntimeByCnpj: vi.fn() }));
vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  return { ...actual, consultarSituacaoNFe: vi.fn() };
});

import { NextResponse } from 'next/server';

import { NFeCertError, consultarSituacaoNFe } from '@delfrance/integrations-nfe';

import { verifyCaller } from '@/lib/nfe/auth';
import { resolveFilialRuntimeByCnpj } from '@/lib/nfe/filial-cert';
import { getNFeRuntime, type NFeBaseRuntime, type NFeRuntime } from '@/lib/nfe/runtime';

import { GET } from '../../../../../app/api/nfe/consultar/route';

// tpEmis digit (index 34) = '1' (normal); emit CNPJ (slice 6–20) = 14200166000187.
const CHAVE = '35260614200166000187550010000000091400000010';
const CNPJ = '14200166000187';

function req(chave = CHAVE): Request {
  return new Request(`http://localhost/api/nfe/consultar?chave=${chave}`, {
    method: 'GET',
    headers: { authorization: 'Bearer t' },
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
    svc: (() => ({ endpoints: {}, agent: {} })) as never,
    an: (() => ({ endpoints: {}, agent: {} })) as never,
    diagnostics: { subjectCommonName: 'TEST', notAfter: '2027-01-01', chainSource: 'x' },
  };
  return { ...rt, envRuntime: () => rt };
}

const RET_AUTORIZADA = {
  cStat: '100',
  xMotivo: 'Autorizado o uso da NF-e',
  protNFe: {
    infProt: { cStat: '100', xMotivo: 'Autorizado o uso da NF-e', nProt: '135250000000001' },
  },
} as never;

beforeEach(() => {
  vi.mocked(verifyCaller).mockResolvedValue({ caller: { uid: 'u-1', permissions: '0xff' } });
  vi.mocked(getNFeRuntime).mockReturnValue(fakeRuntime());
  vi.mocked(resolveFilialRuntimeByCnpj).mockResolvedValue(fakeRuntime());
  vi.mocked(consultarSituacaoNFe).mockResolvedValue(RET_AUTORIZADA);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/nfe/consultar', () => {
  it('401 when auth fails', async () => {
    vi.mocked(verifyCaller).mockResolvedValue({
      error: NextResponse.json({ error: 'no token' }, { status: 401 }),
    });
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('400 on a malformed chave (not 44 digits)', async () => {
    const res = await GET(req('123'));
    expect(res.status).toBe(400);
  });

  it('resolves the signing cert from the chave emit CNPJ and returns the flattened protocolo', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.chave).toBe(CHAVE);
    expect(body.cStat).toBe('100');
    expect(body.xMotivo).toBe('Autorizado o uso da NF-e');
    expect(body.nProt).toBe('135250000000001');
    // The cert comes from the CNPJ embedded in the chave (positions 6–20).
    expect(vi.mocked(resolveFilialRuntimeByCnpj)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      CNPJ,
    );
    // The consulta hits the home SEFAZ consulta URL (tpEmis=1).
    expect(vi.mocked(consultarSituacaoNFe)).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example/sefaz/cons' }),
      { chave: CHAVE },
    );
  });

  it('422 when no filial owns the chave CNPJ (resolveFilialRuntimeByCnpj → NFeCertError)', async () => {
    vi.mocked(resolveFilialRuntimeByCnpj).mockRejectedValue(
      new NFeCertError(`Nenhuma filial cadastrada com o CNPJ ${CNPJ}`),
    );
    const res = await GET(req());
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('NFeCertError');
  });
});
