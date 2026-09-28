/**
 * Route tests for POST /api/nfe/emitir-lote. The batch itself runs REAL
 * (`emitirPedidosLote`); auth, runtime and Firestore are faked, and every
 * SEFAZ binding the batch could reach is mocked, so nothing leaves the process.
 * Pinned here is the HTTP half of the batch contract (#1654 §3):
 *   - a failure of a KNOWN class (`orchestrator/falhas.ts`) stays that
 *     pedido's own report inside a 200;
 *   - a failure of any other class — a bug — is never reported as an ordinary
 *     per-pedido error: the batch rejects and the route answers 500, dropping
 *     the other pedidos' reports with it (here, before any SEFAZ contact);
 *   - 400 / 503 on the request itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/auth')>();
  return { ...actual, verifyCaller: vi.fn() };
});
vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: vi.fn() }));
// The real module's classes stay (the batch's failure table names
// `NFeRuntimeConfigError`); only the runtime itself is faked.
vi.mock('@/lib/nfe/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/runtime')>();
  return { ...actual, getNFeRuntime: vi.fn() };
});
vi.mock('@delfrance/integrations-nfe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/integrations-nfe')>();
  // Every SEFAZ binding the batch could reach is mocked: an offline test must
  // never reach the real transport.
  return {
    ...actual,
    autorizarLote: vi.fn(),
    consultarLote: vi.fn(),
    consultarSituacaoNFe: vi.fn(),
    enviarEpec: vi.fn(),
  };
});

import {
  autorizarLote,
  consultarLote,
  consultarSituacaoNFe,
  enviarEpec,
} from '@delfrance/integrations-nfe';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { PERM, verifyCaller } from '@/lib/nfe/auth';
import { getNFeRuntime, NFeRuntimeConfigError } from '@/lib/nfe/runtime';

import { POST } from '../../../../../app/api/nfe/emitir-lote/route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/nfe/emitir-lote', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A Firestore with no pedido in it: every pedido read answers "not found" (a
 * known failure class) unless its path is in `bugs`, whose read throws that
 * error instead.
 */
function firestoreSemPedidos(bugs: ReadonlyMap<string, unknown> = new Map()) {
  const ref = (path: string) => ({
    path,
    id: path.split('/').pop()!,
    get: async () => {
      if (bugs.has(path)) throw bugs.get(path);
      return { exists: false, id: path.split('/').pop()!, data: () => undefined };
    },
  });
  return {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    doc: (path: string) => ref(path),
  };
}

function expectNoSefazCall(): void {
  expect(vi.mocked(autorizarLote)).not.toHaveBeenCalled();
  expect(vi.mocked(consultarLote)).not.toHaveBeenCalled();
  expect(vi.mocked(consultarSituacaoNFe)).not.toHaveBeenCalled();
  expect(vi.mocked(enviarEpec)).not.toHaveBeenCalled();
}

beforeEach(() => {
  // No reconcile task is ever enqueued here — run the explicit sweep-only mode
  // so `createTaskScheduler()` is the no-op scheduler.
  process.env.NFE_TASKS_DISABLED = '1';
  vi.mocked(verifyCaller).mockResolvedValue({ caller: { uid: 'u-1', permissions: '0xff' } });
  vi.mocked(getNFeRuntime).mockReturnValue({} as never);
  vi.mocked(getAdminFirestore).mockReturnValue(firestoreSemPedidos() as never);
});

afterEach(() => {
  delete process.env.NFE_TASKS_DISABLED;
  vi.clearAllMocks();
});

describe('POST /api/nfe/emitir-lote', () => {
  it('requires PERM.fiscal.write', async () => {
    await POST(req({ pedidoIds: ['PED-X'] }));
    expect(vi.mocked(verifyCaller)).toHaveBeenCalledWith(expect.anything(), PERM.fiscal.write);
  });

  it('400 on an empty pedidoIds', async () => {
    const res = await POST(req({ pedidoIds: [] }));
    expect(res.status).toBe(400);
  });

  it('503 when the runtime is not ready', async () => {
    vi.mocked(getNFeRuntime).mockImplementation(() => {
      throw new NFeRuntimeConfigError('NFE_AMBIENTE inválido');
    });
    const res = await POST(req({ pedidoIds: ['PED-X'] }));
    expect(res.status).toBe(503);
  });

  it('200 — a failure of a known class is that pedido’s own report', async () => {
    const res = await POST(req({ pedidoIds: ['PED-X', 'PED-Y'] }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual(
      ['PED-X', 'PED-Y'].map((pedidoId) => ({
        pedidoId,
        errorCode: 'NFePedidoNotFoundError',
        errorMessage: expect.stringContaining(pedidoId),
      })),
    );
    expectNoSefazCall();
  });

  it('500 — a failure of an unknown class (a bug) fails the whole batch; no pedido is reported, none reached SEFAZ', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'itens')");
    vi.mocked(getAdminFirestore).mockReturnValue(
      firestoreSemPedidos(new Map([['pedidos/PED-BUG', bug]])) as never,
    );

    const res = await POST(req({ pedidoIds: ['PED-X', 'PED-BUG'] }));

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: bug.message, code: 'TypeError' });
    expect(body).not.toHaveProperty('results');
    expectNoSefazCall();
  });
});
