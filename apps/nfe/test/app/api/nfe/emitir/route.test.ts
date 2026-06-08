/**
 * Route tests for POST /api/nfe/emitir. vi.mock the auth + orchestrator +
 * runtime layers so this isolates the route's contract:
 *   - 401 / 403 on auth
 *   - 400 on bad body
 *   - 404 / 409 on orchestrator-thrown errors
 *   - 200 happy path
 *   - 422 when SEFAZ rejected
 *   - 503 if runtime can't boot
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/auth')>();
  return { ...actual, verifyCaller: vi.fn() };
});
vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: vi.fn(() => ({}) as never),
}));
vi.mock('@/lib/nfe/runtime', () => ({ getNFeRuntime: vi.fn() }));
vi.mock('@/lib/nfe/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/orchestrator')>();
  return { ...actual, emitirPedido: vi.fn() };
});

import { NextResponse } from 'next/server';

import { ESTADO_NFE } from '@delfrance/schemas';
import { verifyCaller } from '@/lib/nfe/auth';
import { emitirPedido, NFeBlockedError, NFePedidoNotFoundError } from '@/lib/nfe/orchestrator';
import { getNFeRuntime } from '@/lib/nfe/runtime';

import { POST } from '../../../../../app/api/nfe/emitir/route';

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/nfe/emitir', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  vi.mocked(verifyCaller).mockResolvedValue({
    caller: { uid: 'u-1', permissions: '0xff' },
  });
  vi.mocked(getNFeRuntime).mockReturnValue({} as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/nfe/emitir', () => {
  it('401 when auth fails', async () => {
    vi.mocked(verifyCaller).mockResolvedValue({
      error: NextResponse.json({ error: 'no token' }, { status: 401 }),
    });
    const res = await POST(req({ pedidoId: 'PED-1' }));
    expect(res.status).toBe(401);
  });

  it('400 on missing pedidoId', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it('400 on bad JSON', async () => {
    const res = await POST(req('not json'));
    expect(res.status).toBe(400);
  });

  it('503 when runtime fails to boot', async () => {
    vi.mocked(getNFeRuntime).mockImplementation(() => {
      throw new Error('NFE_CERT_PATH not set');
    });
    const res = await POST(req({ pedidoId: 'PED-1' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'NF-e runtime not ready' });
  });

  it('404 when the pedido is missing', async () => {
    vi.mocked(emitirPedido).mockRejectedValue(new NFePedidoNotFoundError('PED-X'));
    const res = await POST(req({ pedidoId: 'PED-X' }));
    expect(res.status).toBe(404);
  });

  it('409 when bloquearEmissaoNFe is set', async () => {
    vi.mocked(emitirPedido).mockRejectedValue(new NFeBlockedError('PED-Y'));
    const res = await POST(req({ pedidoId: 'PED-Y' }));
    expect(res.status).toBe(409);
  });

  it('200 on cStat=103 (lote recebido)', async () => {
    vi.mocked(emitirPedido).mockResolvedValue({
      nfeId: 'CHAVE-44',
      pedidoId: 'PED-1',
      estado: ESTADO_NFE.aguardandoResposta,
      chave: 'CHAVE-44',
      nRec: '351000000000123',
      cStat: '103',
      xMotivo: 'Lote recebido com sucesso',
      reused: false,
    });
    const res = await POST(req({ pedidoId: 'PED-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: '2', cStat: '103' });
  });

  it('422 when SEFAZ rejected (estado=rejeitada)', async () => {
    vi.mocked(emitirPedido).mockResolvedValue({
      nfeId: 'CHAVE-44',
      pedidoId: 'PED-1',
      estado: ESTADO_NFE.rejeitada,
      chave: 'CHAVE-44',
      nRec: null,
      cStat: '215',
      xMotivo: 'Falha no schema XML',
      reused: false,
    });
    const res = await POST(req({ pedidoId: 'PED-1' }));
    expect(res.status).toBe(422);
  });

  it('500 on unexpected library errors', async () => {
    vi.mocked(emitirPedido).mockRejectedValue(new Error('boom'));
    const res = await POST(req({ pedidoId: 'PED-1' }));
    expect(res.status).toBe(500);
  });
});
