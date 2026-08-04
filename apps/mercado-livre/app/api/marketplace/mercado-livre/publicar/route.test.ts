import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreReauthRequiredError } from '@delfrance/integrations-mercado-livre';

import { MercadoLivrePublishError } from '@/lib/marketplace/publish/publishCore';

// verifyCaller / context loader / orchestrator are mocked; the route's own
// logic (body validation, deps wiring, error mapping) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  publishProduto: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/core/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/core/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@/lib/marketplace/publish/publish', () => ({
  publishProduto: h.publishProduto,
}));

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/publicar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.resolveChannelContext.mockResolvedValue({
    integracaoId: 'int-1',
    accessToken: 'AT',
    account: {},
  });
  h.loadCtx.mockResolvedValue({
    integracaoId: 'int-1',
    conta: {
      tabelaNormalOuterRef: 'documents/listaDePrecos/lista-1',
      depositoOuterRef: 'documents/depositos/dep-1',
    },
    resolveChannelContext: h.resolveChannelContext,
  });
  h.publishProduto.mockResolvedValue({ itemId: 'MLB999', estado: 'p', permalink: 'https://x' });
});

describe('POST /api/marketplace/mercado-livre/publicar', () => {
  it('publishes and returns the item id + estado', async () => {
    const res = await POST(req({ integracaoId: 'int-1', produtoId: 'prod-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ itemId: 'MLB999', estado: 'p', permalink: 'https://x' });

    // deps got the integração's refs + the produto id
    const [deps, produtoId] = h.publishProduto.mock.calls[0]!;
    expect(produtoId).toBe('prod-1');
    expect(deps).toMatchObject({
      integracaoId: 'int-1',
      tabelaNormalOuterRef: 'documents/listaDePrecos/lista-1',
      depositoOuterRef: 'documents/depositos/dep-1',
    });
  });

  it('400s on a missing produtoId, invalid JSON and non-object bodies', async () => {
    expect((await POST(req({ integracaoId: 'int-1' }))).status).toBe(400);
    expect((await POST(req('{not json'))).status).toBe(400);
    // Legal JSON that isn't an object must 400, not crash to a 500.
    expect((await POST(req('null'))).status).toBe(400);
    expect((await POST(req('[]'))).status).toBe(400);
    expect(h.publishProduto).not.toHaveBeenCalled();
  });

  it('maps publish validation issues to 422 ML_PUBLISH_BLOCKED', async () => {
    h.publishProduto.mockRejectedValue(
      new MercadoLivrePublishError(['produto sem fotos', 'sem preço na tabela lista-1']),
    );
    const res = await POST(req({ integracaoId: 'int-1', produtoId: 'prod-1' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('ML_PUBLISH_BLOCKED');
    expect(body.issues).toHaveLength(2);
  });

  it('maps a dead credential to 409 via the shared error mapper', async () => {
    h.resolveChannelContext.mockRejectedValue(
      new MercadoLivreReauthRequiredError('no_token', 'não conectada'),
    );
    const res = await POST(req({ integracaoId: 'int-1', produtoId: 'prod-1' }));
    expect(res.status).toBe(409);
  });

  it('propagates the auth failure from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await POST(req({ integracaoId: 'int-1', produtoId: 'prod-1' }));
    expect(res.status).toBe(403);
  });
});
