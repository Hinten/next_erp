import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';

import { MlTasksDisabledError } from '@/lib/marketplace/tasks/mlTasks';

// verifyCaller / dispatch decision / pedido check / scheduler are mocked; the
// route's own logic (body validation, the 404, skip→409 mapping, the always-202
// enqueue, the disabled-valve 503) and the REAL nfev4Collection path resolution
// (via the fake db below) run real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  get: vi.fn(),
  docPaths: [] as string[],
  decide: vi.fn(),
  shouldUpload: vi.fn(async (..._args: unknown[]) => ({ action: 'enqueue' }) as unknown),
  schedEnqueue: vi.fn(async (_payload: unknown) => {}),
}));

// Fake Firestore exposing only the collection().doc().get() chain the route
// exercises — the real nfev4Collection handle resolves the path against it, so
// the `pedidos/{pedidoId}/nfev4` context wiring is covered too.
vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({
    collection: (path: string) => ({
      doc: (id: string) => ({
        get: () => {
          h.docPaths.push(`${path}/${id}`);
          return h.get();
        },
      }),
    }),
  }),
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/nfe/nfeUpload', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/nfe/nfeUpload')>();
  return { ...actual, decideNfeUploadDispatch: h.decide, shouldUploadForPedido: h.shouldUpload };
});

vi.mock('@/lib/marketplace/tasks/mlNfeUploadTasks', () => ({
  createMlNfeUploadScheduler: () => ({ enqueue: h.schedEnqueue }),
}));

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/enviar-nfe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// Raw doc data as the route hands it to decideNfeUploadDispatch (which is
// mocked — the eligibility logic itself is covered in nfeUpload.test.ts).
const DOC = { estado: 'a', xml_nfe_proc: '<nfeProc/>' };

beforeEach(() => {
  vi.clearAllMocks();
  h.docPaths.length = 0;
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: undefined } });
  h.get.mockResolvedValue({ exists: true, data: () => DOC });
  h.decide.mockReturnValue({ action: 'enqueue' });
  h.shouldUpload.mockResolvedValue({ action: 'enqueue' });
  h.schedEnqueue.mockResolvedValue(undefined);
});

describe('POST /api/marketplace/mercado-livre/enviar-nfe', () => {
  it('requires pedido-write, reads the nfev4 doc, gates doc + pedido, enqueues and 202s', async () => {
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ enqueued: true });

    // Pedido-write scoping (expedição staff), not the integração admin perm.
    expect(h.verifyCaller).toHaveBeenCalledWith(expect.anything(), PERM.pedido.write);
    expect(h.docPaths).toEqual(['pedidos/ped-1/nfev4/s1']);
    // `before: undefined` = judged from scratch on intrinsic eligibility only
    // (zero-write model — no nowMs, no marker state to consult).
    expect(h.decide).toHaveBeenCalledWith(undefined, DOC);
    expect(h.shouldUpload).toHaveBeenCalledWith(expect.anything(), 'ped-1');
    expect(h.schedEnqueue).toHaveBeenCalledWith({ pedidoId: 'ped-1', nfeId: 's1' });
  });

  it('202s on EVERY eligible call — repeat sends are idempotent via the task shipment gate', async () => {
    // No em-andamento / ja-resolvida state exists (zero-write model): the same
    // request enqueues again every time; a duplicate task no-ops at the
    // shipment-status gate. This route IS Step 13's manual retry channel.
    const first = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    const second = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ enqueued: true });
    expect(h.schedEnqueue).toHaveBeenCalledTimes(2);
  });

  it('400s on missing fields, invalid JSON and non-object bodies', async () => {
    expect((await POST(req({ nfeId: 's1' }))).status).toBe(400);
    expect((await POST(req({ pedidoId: 'ped-1' }))).status).toBe(400);
    expect((await POST(req({ pedidoId: '', nfeId: 's1' }))).status).toBe(400);
    expect((await POST(req({ pedidoId: 'ped-1', nfeId: 42 }))).status).toBe(400);
    expect((await POST(req('{not json'))).status).toBe(400);
    expect((await POST(req('null'))).status).toBe(400);
    expect((await POST(req('[]'))).status).toBe(400);
    expect(h.get).not.toHaveBeenCalled();
  });

  it('404s NFE_NAO_ENCONTRADA when the NF-e doc does not exist', async () => {
    h.get.mockResolvedValue({ exists: false, data: () => undefined });
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 'missing' }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NFE_NAO_ENCONTRADA');
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.shouldUpload).not.toHaveBeenCalled();
    expect(h.schedEnqueue).not.toHaveBeenCalled();
  });

  it('409s NFE_NAO_ELEGIVEL with the doc-level machine reason passed through', async () => {
    h.decide.mockReturnValue({ action: 'skip', reason: 'nao-aprovada' });
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NFE_NAO_ELEGIVEL');
    expect(body.reason).toBe('nao-aprovada');
    // A doc-level skip short-circuits BEFORE the pedido read.
    expect(h.shouldUpload).not.toHaveBeenCalled();
    expect(h.schedEnqueue).not.toHaveBeenCalled();

    h.decide.mockReturnValue({ action: 'skip', reason: 'tpamb-homologacao' });
    const res2 = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res2.status).toBe(409);
    expect((await res2.json()).reason).toBe('tpamb-homologacao');
  });

  it('409s NFE_NAO_ELEGIVEL with the pedido-level reason from shouldUploadForPedido', async () => {
    for (const reason of ['pedido-nao-encontrado', 'nao-mercado-livre', 'sem-integracao']) {
      h.shouldUpload.mockResolvedValue({ action: 'skip', reason });
      const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('NFE_NAO_ELEGIVEL');
      expect(body.reason).toBe(reason);
      expect(typeof body.error).toBe('string');
    }
    expect(h.schedEnqueue).not.toHaveBeenCalled();
  });

  it('503s ML_NFE_UPLOAD_ENQUEUE_FAILED when the tasks valve is shut (MlTasksDisabledError)', async () => {
    h.schedEnqueue.mockRejectedValue(new MlTasksDisabledError());
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('ML_NFE_UPLOAD_ENQUEUE_FAILED');
  });

  it('rethrows an unexpected enqueue failure instead of masking it as a 503', async () => {
    h.schedEnqueue.mockRejectedValue(new Error('cloudtasks down'));
    await expect(POST(req({ pedidoId: 'ped-1', nfeId: 's1' }))).rejects.toThrow('cloudtasks down');
  });

  it('propagates the auth failure from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res.status).toBe(403);
    expect(h.get).not.toHaveBeenCalled();
  });
});
