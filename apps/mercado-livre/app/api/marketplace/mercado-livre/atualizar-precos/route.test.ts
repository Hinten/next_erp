import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PriceSyncAlreadyRunningError } from '@/lib/marketplace/precoSync';

// verifyCaller / context loader / job start / scheduler / job-doc merge are
// mocked; the route's own logic (body validation, the tabela-normal gate,
// error mapping, enqueue-failure fallback) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  startPriceSyncJob: vi.fn(),
  enqueue: vi.fn(async (_payload: unknown) => {}),
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

vi.mock('@/lib/marketplace/precoSync', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/precoSync')>();
  return { ...actual, startPriceSyncJob: h.startPriceSyncJob };
});

vi.mock('@/lib/marketplace/mlPriceSyncTasks', () => ({
  createMlPriceSyncScheduler: () => ({ enqueue: h.enqueue }),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  envioPrecoMercadoLivreCollection: { merge: h.merge },
  integracaoCollection: {},
}));

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/atualizar-precos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: undefined } });
  h.loadCtx.mockResolvedValue({
    integracaoId: 'int-1',
    conta: { user_id: 55, tabelaNormalOuterRef: 'documents/listaDePrecos/lista-1' },
    resolveChannelContext: vi.fn(),
  });
  h.startPriceSyncJob.mockResolvedValue({ jobId: 'job-1' });
  h.enqueue.mockResolvedValue(undefined);
});

describe('POST /api/marketplace/mercado-livre/atualizar-precos', () => {
  it('validates the account, starts the job (baixarPreco defaults false), enqueues, and 202s the jobId', async () => {
    const res = await POST(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId: 'job-1' });

    expect(h.loadCtx).toHaveBeenCalledWith(expect.anything(), 'int-1');
    expect(h.startPriceSyncJob).toHaveBeenCalledWith(expect.anything(), {
      integracaoId: 'int-1',
      baixarPreco: false,
      startedBy: 'u1',
    });
    expect(h.enqueue).toHaveBeenCalledWith({ jobId: 'job-1', integracaoId: 'int-1' });
    expect(h.merge).not.toHaveBeenCalled();
  });

  it('forwards baixarPreco: true when the caller opts into price decreases', async () => {
    await POST(req({ integracaoId: 'int-1', baixarPreco: true }));
    const [, args] = h.startPriceSyncJob.mock.calls[0]!;
    expect(args).toEqual({ integracaoId: 'int-1', baixarPreco: true, startedBy: 'u1' });
  });

  it('400s on a missing integracaoId, invalid JSON, non-object bodies and a non-boolean baixarPreco', async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req('{not json'))).status).toBe(400);
    expect((await POST(req('null'))).status).toBe(400);
    expect((await POST(req('[]'))).status).toBe(400);
    expect((await POST(req({ integracaoId: 'int-1', baixarPreco: 'sim' }))).status).toBe(400);
    expect(h.startPriceSyncJob).not.toHaveBeenCalled();
  });

  it('400s SEM_TABELA_NORMAL when the conta has no tabela normal configured (no job created)', async () => {
    h.loadCtx.mockResolvedValue({
      integracaoId: 'int-1',
      conta: { user_id: 55, tabelaNormalOuterRef: null },
      resolveChannelContext: vi.fn(),
    });
    const res = await POST(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('SEM_TABELA_NORMAL');
    expect(h.startPriceSyncJob).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('maps an unknown/wrong-tipo account to its error response (mirrors /importar-todos)', async () => {
    const { MercadoLivreContaNotConfiguredError } = await import('@/lib/marketplace/mercadoLivre');
    h.loadCtx.mockRejectedValue(new MercadoLivreContaNotConfiguredError('não encontrada'));
    const res = await POST(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(404);
    expect(h.startPriceSyncJob).not.toHaveBeenCalled();
  });

  it('409s ML_PRICE_SYNC_RUNNING when a job is already running for the account', async () => {
    h.startPriceSyncJob.mockRejectedValue(
      new PriceSyncAlreadyRunningError('já existe uma sincronização de preços em andamento'),
    );
    const res = await POST(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('ML_PRICE_SYNC_RUNNING');
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('marks the fresh job failed and 503s ML_PRICE_SYNC_ENQUEUE_FAILED when the enqueue throws', async () => {
    h.enqueue.mockRejectedValue(new Error('cloudtasks down'));
    const res = await POST(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('ML_PRICE_SYNC_ENQUEUE_FAILED');
    expect(body.error).toBe('cloudtasks down');
    expect(h.merge).toHaveBeenCalledOnce();
    const [, , id, patch] = h.merge.mock.calls[0]!;
    expect(id).toBe('job-1');
    expect(patch).toMatchObject({ status: 'failed', erro: 'cloudtasks down' });
  });

  it('still 503s when the failure-stamp itself throws — the stamp is best-effort, only logged', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.enqueue.mockRejectedValue(new Error('cloudtasks down'));
    // Once-only: h.merge is not re-primed in beforeEach, so a sticky rejection
    // would leak into later tests.
    h.merge.mockRejectedValueOnce(new Error('firestore down'));

    const res = await POST(req({ integracaoId: 'int-1' }));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('ML_PRICE_SYNC_ENQUEUE_FAILED');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failure-stamp'),
      expect.objectContaining({ jobId: 'job-1', message: 'firestore down' }),
    );
    warnSpy.mockRestore();
  });

  it('propagates the auth failure from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await POST(req({ integracaoId: 'int-1' }));
    expect(res.status).toBe(403);
  });
});
