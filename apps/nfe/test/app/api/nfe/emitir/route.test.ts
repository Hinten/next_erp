/**
 * Route tests for POST /api/nfe/emitir. vi.mock the auth + orchestrator +
 * runtime layers so this isolates the route's contract:
 *   - 401 / 403 on auth
 *   - 400 on bad body, and on an operator-fixable NFeOrchestratorError
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
import {
  emitirPedido,
  NFeBlockedError,
  NFeOrchestratorError,
  NFePedidoNotFoundError,
} from '@/lib/nfe/orchestrator';
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
  // The orchestrator is mocked, so Cloud Tasks isn't exercised here — run in
  // the explicit sweep-only mode so `createTaskScheduler()` returns a no-op
  // instead of fail-fasting on the absent NFE_TASKS_* config.
  process.env.NFE_TASKS_DISABLED = '1';
  vi.mocked(verifyCaller).mockResolvedValue({
    caller: { uid: 'u-1', permissions: '0xff' },
  });
  vi.mocked(getNFeRuntime).mockReturnValue({} as never);
});

afterEach(() => {
  delete process.env.NFE_TASKS_DISABLED;
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

  it('400 when emitirPedido throws NFeOrchestratorError, message passed through', async () => {
    // A contract pin on the ROUTE only: the NFeOrchestratorError → 400 mapping
    // predates #506, and the #506 fix relies on it to answer an unbuildable tax
    // config with an operator-fixable 400 rather than the 500 below.
    // emitirPedido is mocked and the message is a sample, so this test does NOT
    // show that the orchestrator throws that class. The generator-input,
    // orchestrator and emitir-pedidos-lote tests do.
    const message =
      "pedido 'PED-1' item 0 (produto 'P-1'): CSOSN '900': XSD sub-groups must be " +
      'emitted complete or omitted — ICMS próprio missing: modBC';
    vi.mocked(emitirPedido).mockRejectedValue(new NFeOrchestratorError(message));
    const res = await POST(req({ pedidoId: 'PED-1' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: message });
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
