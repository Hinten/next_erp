import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';

import { MlTasksDisabledError } from '@/lib/marketplace/mlTasks';

// verifyCaller / dispatch decision / enqueue are mocked; the route's own logic
// (body validation, the 404, skip→status mapping, the disabled-valve 503) and
// the REAL nfev4Collection path resolution (via the fake db below) run real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  get: vi.fn(),
  docPaths: [] as string[],
  decide: vi.fn(),
  enqueueNfeUpload: vi.fn(async (..._args: unknown[]) => {}),
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

vi.mock('@/lib/marketplace/nfeUpload', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/nfeUpload')>();
  return { ...actual, decideNfeUploadDispatch: h.decide, enqueueNfeUpload: h.enqueueNfeUpload };
});

vi.mock('@/lib/marketplace/mlNfeUploadTasks', () => ({
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
  h.enqueueNfeUpload.mockResolvedValue(undefined);
});

describe('POST /api/marketplace/mercado-livre/enviar-nfe', () => {
  it('requires pedido-write, reads the nfev4 doc, decides from scratch, enqueues and 202s', async () => {
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ enqueued: true });

    // Pedido-write scoping (expedição staff), not the integração admin perm.
    expect(h.verifyCaller).toHaveBeenCalledWith(expect.anything(), PERM.pedido.write);
    expect(h.docPaths).toEqual(['pedidos/ped-1/nfev4/s1']);
    // `before: undefined` = the manual-retry semantics: a marker-'erro' or
    // stale-'pendente' doc is judged from scratch and re-enqueues.
    expect(h.decide).toHaveBeenCalledWith(undefined, DOC, expect.any(Number));
    expect(h.enqueueNfeUpload).toHaveBeenCalledWith(
      expect.anything(),
      { enqueue: h.schedEnqueue },
      { pedidoId: 'ped-1', nfeId: 's1' },
      expect.any(Number),
    );
    // The same captured nowMs feeds both the decision and the enqueue.
    const decideNow = h.decide.mock.calls[0]![2];
    expect(h.enqueueNfeUpload.mock.calls[0]![3]).toBe(decideNow);
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
    expect(h.enqueueNfeUpload).not.toHaveBeenCalled();
  });

  it('409s NFE_NAO_ELEGIVEL with the machine reason passed through on an ineligible doc', async () => {
    h.decide.mockReturnValue({ action: 'skip', reason: 'nao-aprovada' });
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NFE_NAO_ELEGIVEL');
    expect(body.reason).toBe('nao-aprovada');
    expect(h.enqueueNfeUpload).not.toHaveBeenCalled();

    h.decide.mockReturnValue({ action: 'skip', reason: 'tpamb-homologacao' });
    const res2 = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res2.status).toBe(409);
    expect((await res2.json()).reason).toBe('tpamb-homologacao');
  });

  it('202s { enqueued: false, emAndamento: true } when an upload is already in flight', async () => {
    h.decide.mockReturnValue({ action: 'skip', reason: 'em-andamento' });
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ enqueued: false, emAndamento: true });
    expect(h.enqueueNfeUpload).not.toHaveBeenCalled();
  });

  it('503s ML_NFE_UPLOAD_ENQUEUE_FAILED when the tasks valve is shut (MlTasksDisabledError)', async () => {
    h.enqueueNfeUpload.mockRejectedValue(new MlTasksDisabledError());
    const res = await POST(req({ pedidoId: 'ped-1', nfeId: 's1' }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('ML_NFE_UPLOAD_ENQUEUE_FAILED');
  });

  it('rethrows an unexpected enqueue failure instead of masking it as a 503', async () => {
    h.enqueueNfeUpload.mockRejectedValue(new Error('cloudtasks down'));
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
