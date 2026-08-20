import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MassImportAlreadyRunningError } from '@/lib/marketplace/massImport';

// verifyCaller / context loader / job start / scheduler / job-doc merge are
// mocked; the route's own logic (body validation, defaults, error mapping,
// enqueue-failure fallback) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  startMassImportJob: vi.fn(),
  enqueue: vi.fn(async (_payload: unknown) => {}),
  finalizeMassImportJob: vi.fn(async (..._args: unknown[]) => 'stamped'),
  merge: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@/lib/marketplace/massImport', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/massImport')>();
  return {
    ...actual,
    startMassImportJob: h.startMassImportJob,
    finalizeMassImportJob: h.finalizeMassImportJob,
  };
});

vi.mock('@/lib/marketplace/mlMassImportTasks', () => ({
  createMlMassImportScheduler: () => ({ enqueue: h.enqueue }),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  importacaoMercadoLivreCollection: { merge: h.merge },
  integracaoCollection: {},
}));

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/importar-todos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const FULL_DEFAULTS = {
  importarEstoque: true,
  sobrescreverEstoque: false,
  importarPreco: true,
  sobrescreverPreco: true,
  atualizarProdutoPai: true,
  importarFotos: true,
  importarCategorias: true,
  atualizarCadastrados: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.loadCtx.mockResolvedValue({
    integracaoId: 'int-1',
    conta: { user_id: 55 },
    resolveChannelContext: vi.fn(),
  });
  h.startMassImportJob.mockResolvedValue('job-1');
  h.enqueue.mockResolvedValue(undefined);
});

describe('POST /api/marketplace/mercado-livre/importar-todos', () => {
  it('validates the account, starts the job with full defaults applied, enqueues, and 202s the jobId', async () => {
    const res = await POST(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId: 'job-1' });

    expect(h.loadCtx).toHaveBeenCalledWith(expect.anything(), 'int-1');
    expect(h.startMassImportJob).toHaveBeenCalledWith(expect.anything(), {
      integracaoId: 'int-1',
      options: FULL_DEFAULTS,
    });
    expect(h.enqueue).toHaveBeenCalledWith({ jobId: 'job-1', integracaoId: 'int-1' });
    expect(h.merge).not.toHaveBeenCalled();
  });

  it('forwards only known boolean flags, overriding just those defaults', async () => {
    await POST(
      req({
        integracaoId: 'int-1',
        options: { sobrescreverEstoque: true, atualizarCadastrados: true, bogus: 'x' },
      }),
    );
    const [, args] = h.startMassImportJob.mock.calls[0]!;
    expect(args).toEqual({
      integracaoId: 'int-1',
      options: { ...FULL_DEFAULTS, sobrescreverEstoque: true, atualizarCadastrados: true },
    });
  });

  it('400s on a missing integracaoId, invalid JSON and non-object bodies', async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req('{not json'))).status).toBe(400);
    expect((await POST(req('null'))).status).toBe(400);
    expect((await POST(req('[]'))).status).toBe(400);
    expect(h.startMassImportJob).not.toHaveBeenCalled();
  });

  it('maps an unknown/wrong-tipo account to its error response (mirrors /importar)', async () => {
    const { MercadoLivreContaNotConfiguredError } = await import('@/lib/marketplace/mercadoLivre');
    h.loadCtx.mockRejectedValue(new MercadoLivreContaNotConfiguredError('não encontrada'));
    const res = await POST(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(404);
    expect(h.startMassImportJob).not.toHaveBeenCalled();
  });

  it('409s ML_MASS_IMPORT_RUNNING when a job is already running for the account', async () => {
    h.startMassImportJob.mockRejectedValue(
      new MassImportAlreadyRunningError('já existe uma importação em andamento'),
    );
    const res = await POST(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('ML_MASS_IMPORT_RUNNING');
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('marks the fresh job failed and 503s ML_MASS_IMPORT_ENQUEUE_FAILED when the enqueue throws', async () => {
    h.enqueue.mockRejectedValue(new Error('cloudtasks down'));
    const res = await POST(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('ML_MASS_IMPORT_ENQUEUE_FAILED');
    expect(body.error).toBe('cloudtasks down');
    expect(h.finalizeMassImportJob).toHaveBeenCalledOnce();
    const [, id, patch] = h.finalizeMassImportJob.mock.calls[0]!;
    expect(id).toBe('job-1');
    expect(patch).toMatchObject({ status: 'failed', erro: 'cloudtasks down' });
  });

  it('propagates the auth failure from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await POST(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(403);
  });
});
