import { beforeEach, describe, expect, it, vi } from 'vitest';

// verifyCaller and the job-core cancel are mocked; the route's own logic (body
// validation, outcome → status mapping) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  cancelMassImportJob: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/massImport', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/massImport')>();
  return { ...actual, cancelMassImportJob: h.cancelMassImportJob };
});

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request(
    'http://localhost:3006/api/marketplace/mercado-livre/importar-todos/cancelar',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.cancelMassImportJob.mockResolvedValue('stamped');
});

describe('POST /api/marketplace/mercado-livre/importar-todos/cancelar', () => {
  it('cancels the job and reports the new state', async () => {
    const res = await POST(req({ integracaoId: 'int-1', jobId: 'job-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'cancelled' });
    expect(h.cancelMassImportJob).toHaveBeenCalledWith(expect.anything(), {
      jobId: 'job-1',
      integracaoId: 'int-1',
    });
  });

  it('is write-gated, not read-gated — it stops work, it does not report on it', async () => {
    const { PERM } = await import('@/lib/auth/verifyCaller');
    await POST(req({ integracaoId: 'int-1', jobId: 'job-1' }));
    expect(h.verifyCaller).toHaveBeenCalledWith(expect.anything(), PERM.integracao.write);
  });

  it('409s ML_MASS_IMPORT_NOT_RUNNING when the job already reached a terminal state', async () => {
    h.cancelMassImportJob.mockResolvedValue('not-running');
    const res = await POST(req({ integracaoId: 'int-1', jobId: 'job-1' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ML_MASS_IMPORT_NOT_RUNNING');
  });

  it("404s identically for a missing job and another conta's job", async () => {
    // Same body on purpose: a stray id must not reveal whether it exists at
    // all, matching status/route.ts.
    h.cancelMassImportJob.mockResolvedValue('not-found');
    const ausente = await POST(req({ integracaoId: 'int-1', jobId: 'job-1' }));
    h.cancelMassImportJob.mockResolvedValue('wrong-integracao');
    const alheio = await POST(req({ integracaoId: 'int-1', jobId: 'job-1' }));

    expect(ausente.status).toBe(404);
    expect(alheio.status).toBe(404);
    expect(await ausente.json()).toEqual(await alheio.json());
  });

  it('400s a body missing either id, without touching the job', async () => {
    for (const body of [{}, { integracaoId: 'int-1' }, { jobId: 'job-1' }]) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
    }
    expect((await POST(req('{'))).status).toBe(400);
    expect(h.cancelMassImportJob).not.toHaveBeenCalled();
  });

  it('propagates the auth failure from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await POST(req({ integracaoId: 'int-1', jobId: 'job-1' }));
    expect(res.status).toBe(403);
    expect(h.cancelMassImportJob).not.toHaveBeenCalled();
  });
});
