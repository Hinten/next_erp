/**
 * Route tests for POST /api/nfe/verificar. vi.mock auth + runtime +
 * Firestore + the `verificarEnviNfeMsgs` core to isolate the route contract:
 *   - 401 on auth (and the perm asked for is PERM.fiscal.write — mutating op)
 *   - 400 on a bad body (missing filialId / empty ids / >10 ids / bad JSON)
 *   - 503 when the runtime is not ready
 *   - 422 `code: 'NFeCertError'` when the filial has no usable A1
 *   - 500 (message only) on an unisolated transport failure
 *   - 200 passthrough of the VerificarEnviNfeResult body — per-chave
 *     failures (skipped-final / erro entries) never become HTTP errors
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/auth')>();
  return { ...actual, verifyCaller: vi.fn() };
});
vi.mock('@/lib/nfe/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/runtime')>();
  return { ...actual, getNFeRuntime: vi.fn() };
});
vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: vi.fn(() => ({})) }));
vi.mock('@/lib/nfe/orchestrator/verificar', () => ({ verificarEnviNfeMsgs: vi.fn() }));

import { NextResponse } from 'next/server';

import { NFeCertError, NFeTransportError } from '@delfrance/integrations-nfe';

import { PERM, verifyCaller } from '@/lib/nfe/auth';
import { verificarEnviNfeMsgs } from '@/lib/nfe/orchestrator/verificar';
import { getNFeRuntime, NFeRuntimeConfigError } from '@/lib/nfe/runtime';

import { POST } from '../../../../../app/api/nfe/verificar/route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/nfe/verificar', {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID_BODY = { filialId: 'F-1', enviNfeMsgIds: ['msg-1'] };

beforeEach(() => {
  vi.mocked(verifyCaller).mockResolvedValue({
    caller: { uid: 'u-1', permissions: '0xff' },
  } as never);
  vi.mocked(getNFeRuntime).mockReturnValue({} as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/nfe/verificar', () => {
  it('401 when auth fails — and the route asks for PERM.fiscal.write', async () => {
    vi.mocked(verifyCaller).mockResolvedValue({
      error: NextResponse.json({ error: 'no token' }, { status: 401 }),
    });
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(401);
    expect(vi.mocked(verifyCaller)).toHaveBeenCalledWith(expect.anything(), PERM.fiscal.write);
    expect(vi.mocked(verificarEnviNfeMsgs)).not.toHaveBeenCalled();
  });

  it('400 when filialId is missing', async () => {
    const res = await POST(req({ enviNfeMsgIds: ['msg-1'] }));
    expect(res.status).toBe(400);
    expect(vi.mocked(verificarEnviNfeMsgs)).not.toHaveBeenCalled();
  });

  it('400 on an empty enviNfeMsgIds array', async () => {
    const res = await POST(req({ filialId: 'F-1', enviNfeMsgIds: [] }));
    expect(res.status).toBe(400);
  });

  it('400 on more than 10 enviNfeMsgIds', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `msg-${i}`);
    const res = await POST(req({ filialId: 'F-1', enviNfeMsgIds: ids }));
    expect(res.status).toBe(400);
  });

  it("400 when filialId contains '/' (Firestore path segment)", async () => {
    const res = await POST(req({ filialId: 'a/b', enviNfeMsgIds: ['msg-1'] }));
    expect(res.status).toBe(400);
    expect(vi.mocked(verificarEnviNfeMsgs)).not.toHaveBeenCalled();
  });

  it("400 when an enviNfeMsgId contains '/' (Firestore path segment)", async () => {
    const res = await POST(req({ filialId: 'F-1', enviNfeMsgIds: ['msg-1', 'a/b'] }));
    expect(res.status).toBe(400);
    expect(vi.mocked(verificarEnviNfeMsgs)).not.toHaveBeenCalled();
  });

  it('400 on malformed JSON', async () => {
    const res = await POST(req('{not json'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('Bad JSON body');
  });

  it('503 when the runtime is misconfigured (NFeRuntimeConfigError)', async () => {
    vi.mocked(getNFeRuntime).mockImplementation(() => {
      throw new NFeRuntimeConfigError('NFE_AMBIENTE inválido');
    });
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('NFE_AMBIENTE inválido');
  });

  it('a non-config runtime failure is rethrown, never masked as 503', async () => {
    vi.mocked(getNFeRuntime).mockImplementation(() => {
      throw new Error('unexpected bug');
    });
    await expect(POST(req(VALID_BODY))).rejects.toThrow('unexpected bug');
  });

  it("422 with code 'NFeCertError' when the filial has no usable A1", async () => {
    vi.mocked(verificarEnviNfeMsgs).mockRejectedValue(
      new NFeCertError("Filial 'F-1' não possui certificado digital cadastrado."),
    );
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('NFeCertError');
  });

  it('500 (message only) on an unisolated transport failure — responseBody never leaves', async () => {
    vi.mocked(verificarEnviNfeMsgs).mockRejectedValue(
      new NFeTransportError('SEFAZ HTTP 502', 502, '<xml>raw-sefaz-body</xml>'),
    );
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('SEFAZ HTTP 502');
    expect(JSON.stringify(body)).not.toContain('raw-sefaz-body');
  });

  it('200 passthrough of the VerificarEnviNfeResult — skipped-final and erro entries stay 200', async () => {
    const result = {
      filialId: 'F-1',
      results: [
        {
          chave: '35260614200166000187550010000000091400000010',
          status: 'skipped-final',
          estadoAnterior: 'c',
          estadoNovo: 'c',
          cStat: '101',
          xMotivo: 'Cancelamento de NF-e homologado',
          error: null,
        },
        {
          chave: '35260614200166000187550010000000092400000011',
          status: 'erro',
          estadoAnterior: '2',
          estadoNovo: '2',
          cStat: null,
          xMotivo: null,
          error: 'NFeTransportError: SEFAZ HTTP 500',
        },
      ],
      msgsNaoEncontradas: ['msg-missing'],
    };
    vi.mocked(verificarEnviNfeMsgs).mockResolvedValue(result as never);

    const res = await POST(req({ filialId: 'F-1', enviNfeMsgIds: ['msg-1', 'msg-missing'] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(result);
    expect(vi.mocked(verificarEnviNfeMsgs)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        filialId: 'F-1',
        enviNfeMsgIds: ['msg-1', 'msg-missing'],
      },
    );
  });
});
