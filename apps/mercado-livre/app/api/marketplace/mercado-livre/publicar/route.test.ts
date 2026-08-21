import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreReauthRequiredError } from '@delfrance/integrations-mercado-livre';

import { MercadoLivrePublishError } from '@/lib/marketplace/publishCore';

// verifyCaller / context loader / orchestrator are mocked; the route's own
// logic (body validation, deps wiring, error mapping) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  publishProduto: vi.fn(),
  docRef: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@/lib/marketplace/publish', () => ({
  publishProduto: h.publishProduto,
}));

// Only the ownership probe the route runs when `linkDocId` is present — the rest
// of the collections module stays real.
vi.mock('@delfrance/data/admin/collections', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/data/admin/collections')>();
  return {
    ...actual,
    produtoMercadoLivreLinkCollection: {
      ...actual.produtoMercadoLivreLinkCollection,
      docRef: h.docRef,
    },
  };
});

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/publicar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Point the mocked `docRef(...).get()` at a link doc (or at nothing). */
function seedLink(data: Record<string, unknown> | null): void {
  h.docRef.mockReturnValue({
    get: async () => ({ exists: data !== null, data: () => data ?? undefined }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seedLink({ contaOuterRef: 'documents/integracao/int-1', id: null, estado: 'r' });
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

/**
 * A produto can carry more than one anúncio on the SAME conta, and the
 * orchestrator's link lookup would otherwise take whichever comes first —
 * silently re-publishing the wrong listing. `linkDocId` names the one meant.
 */
describe('POST /api/marketplace/mercado-livre/publicar — linkDocId', () => {
  it('forwards the named listing to the orchestrator', async () => {
    const res = await POST(
      req({ integracaoId: 'int-1', produtoId: 'prod-1', linkDocId: 'ML-DOC-2' }),
    );

    expect(res.status).toBe(200);
    expect(h.publishProduto.mock.calls[0]![0]).toMatchObject({ linkDocId: 'ML-DOC-2' });
    // The probe ran against THIS produto's subcollection, not a global lookup.
    expect(h.docRef.mock.calls[0]!.slice(1)).toEqual([{ produtoId: 'prod-1' }, 'ML-DOC-2']);
  });

  it('passes null when the caller names no listing', async () => {
    // The regression guard for every existing caller: the historical behaviour
    // is "the conta's first link doc", and it must survive untouched.
    const res = await POST(req({ integracaoId: 'int-1', produtoId: 'prod-1' }));

    expect(res.status).toBe(200);
    expect(h.publishProduto.mock.calls[0]![0]).toMatchObject({ linkDocId: null });
    // No ownership probe to run, so no read spent on one.
    expect(h.docRef).not.toHaveBeenCalled();
  });

  it('404s a listing this produto does not have', async () => {
    seedLink(null);
    const res = await POST(
      req({ integracaoId: 'int-1', produtoId: 'prod-1', linkDocId: 'ML-DOC-FANTASMA' }),
    );

    expect(res.status).toBe(404);
    expect(h.publishProduto).not.toHaveBeenCalled();
  });

  it('404s a listing that belongs to another conta', async () => {
    // Without this the body alone would decide whose listing gets published,
    // under whichever conta's token the caller named.
    seedLink({ contaOuterRef: 'documents/integracao/outra-conta', id: 'MLB1', estado: 'p' });
    const res = await POST(
      req({ integracaoId: 'int-1', produtoId: 'prod-1', linkDocId: 'ML-DOC-2' }),
    );

    expect(res.status).toBe(404);
    expect(h.publishProduto).not.toHaveBeenCalled();
  });

  it('400s a present-but-unusable linkDocId without touching Firestore', async () => {
    // A truthy non-string sails past a `!value` guard and then throws inside
    // `.doc(id)` — a 500 for what is a client error.
    for (const linkDocId of [1, '', {}, []]) {
      const res = await POST(req({ integracaoId: 'int-1', produtoId: 'prod-1', linkDocId }));
      expect(res.status).toBe(400);
    }
    expect(h.docRef).not.toHaveBeenCalled();
    expect(h.publishProduto).not.toHaveBeenCalled();
  });
});
