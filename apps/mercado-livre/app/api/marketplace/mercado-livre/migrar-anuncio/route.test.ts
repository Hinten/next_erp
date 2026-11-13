import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  readLink: vi.fn(),
  loadContext: vi.fn(),
  start: vi.fn(),
  reconcile: vi.fn(),
  enqueue: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('@/lib/auth/verifyCaller', async (load) => ({
  ...(await load<typeof import('@/lib/auth/verifyCaller')>()),
  verifyCaller: h.verifyCaller,
}));
vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));
vi.mock('@delfrance/data/admin/collections', async (load) => ({
  ...(await load<typeof import('@delfrance/data/admin/collections')>()),
  produtoMercadoLivreLinkCollection: { docRef: () => ({ get: h.readLink }) },
}));
vi.mock('@/lib/marketplace/core/mercadoLivre', async (load) => ({
  ...(await load<typeof import('@/lib/marketplace/core/mercadoLivre')>()),
  loadMercadoLivreContext: h.loadContext,
}));
vi.mock('@/lib/marketplace/importacao/importMigration', async (load) => ({
  ...(await load<typeof import('@/lib/marketplace/importacao/importMigration')>()),
  startUptinMigration: h.start,
  handleUptinMigration: h.reconcile,
}));
vi.mock('@/lib/marketplace/notificacoes/mlTasks', async (load) => ({
  ...(await load<typeof import('@/lib/marketplace/notificacoes/mlTasks')>()),
  createMlTaskScheduler: () => ({ enqueue: h.enqueue }),
}));
vi.mock('@/lib/marketplace/notificacoes/notificacao', () => ({
  persistNotificationFailure: h.persist,
}));

import { PERM } from '@/lib/auth/verifyCaller';
import { MlTasksDisabledError } from '@/lib/marketplace/notificacoes/mlTasks';
import { POST } from './route';

function request(acao = 'iniciar') {
  return new Request('http://localhost/api/marketplace/mercado-livre/migrar-anuncio', {
    method: 'POST',
    body: JSON.stringify({ integracaoId: 'int', produtoId: 'prod', linkDocId: 'link', acao }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  h.verifyCaller.mockResolvedValue({ uid: 'operator' });
  h.readLink.mockResolvedValue({ data: () => ({ id: 'MLB111', contaOuterRef: 'integracao/int' }) });
  h.loadContext.mockResolvedValue({
    conta: { user_id: 42 },
    resolveChannelContext: async () => ({ getAccessToken: async () => 'fake' }),
  });
  h.start.mockImplementation(async (_deps, _item, _target, arm: () => Promise<void>) => {
    await arm();
    return 'iniciada';
  });
});

describe('POST /migrar-anuncio', () => {
  it('checks integration write permission before reading the listing', async () => {
    h.verifyCaller.mockResolvedValue({ error: NextResponse.json({}, { status: 403 }) });
    const req = request();
    expect((await POST(req)).status).toBe(403);
    expect(h.verifyCaller).toHaveBeenCalledExactlyOnceWith(req, PERM.integracao.write);
    expect(h.readLink).not.toHaveBeenCalled();
  });

  it('rejects a listing from another integration before loading credentials', async () => {
    h.readLink.mockResolvedValue({
      data: () => ({ id: 'MLB111', contaOuterRef: 'integracao/other' }),
    });
    expect((await POST(request())).status).toBe(404);
    expect(h.loadContext).not.toHaveBeenCalled();
  });

  it('arms the existing queue and uses the failure sweep when it is disabled', async () => {
    h.enqueue.mockRejectedValue(new MlTasksDisabledError());
    const response = await POST(request());
    expect(response.status).toBe(202);
    const payload = expect.objectContaining({
      topic: 'items',
      resource: '/items/MLB111',
      user_id: 42,
    });
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(payload, { scheduleDelaySeconds: 300 });
    expect(h.persist).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      payload,
      expect.any(String),
    );
  });

  it('reconciles a manual check without submitting or arming a new task', async () => {
    h.reconcile.mockResolvedValue('pendente');
    expect(await (await POST(request('reverificar'))).json()).toEqual({ estado: 'pendente' });
    expect(h.reconcile).toHaveBeenCalledWith(
      expect.anything(),
      'MLB111',
      expect.objectContaining({ linkDocId: 'link' }),
    );
    expect(h.start).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
