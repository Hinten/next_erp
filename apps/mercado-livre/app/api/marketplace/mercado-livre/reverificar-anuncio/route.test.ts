import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

// verifyCaller / context loader / the ML client / the shared status writeback are
// mocked; the route's own logic (body validation, ownership check, error mapping)
// runs for real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  createApi: vi.fn(),
  getItem: vi.fn(),
  docRef: vi.fn(),
  applyItemStatusToLink: vi.fn(),
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

vi.mock('@/lib/marketplace/itemsStatusSync', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/itemsStatusSync')>();
  return { ...actual, applyItemStatusToLink: h.applyItemStatusToLink };
});

vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return { ...actual, createMercadoLivreApi: h.createApi };
});

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

const CONTA = 'int-1';
const PRODUTO = 'prod-1';
const LINK = 'link-1';
const ITEM = 'MLB111';

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/reverificar-anuncio', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = { integracaoId: CONTA, produtoId: PRODUTO, linkDocId: LINK };

/** Point the mocked `docRef(...).get()` at a link doc (or at nothing). */
function seedLink(data: Record<string, unknown> | null): void {
  h.docRef.mockReturnValue({
    get: async () => ({ exists: data !== null, data: () => data ?? undefined }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.resolveChannelContext.mockResolvedValue({ accessToken: 'AT' });
  h.loadCtx.mockResolvedValue({ conta: {}, resolveChannelContext: h.resolveChannelContext });
  h.createApi.mockReturnValue({ getItem: h.getItem });
  h.getItem.mockResolvedValue({ id: ITEM, status: 'active', sub_status: [] });
  h.applyItemStatusToLink.mockResolvedValue(undefined);
  seedLink({ contaOuterRef: `documents/integracao/${CONTA}`, id: ITEM, estado: 'E' });
});

describe('POST /api/marketplace/mercado-livre/reverificar-anuncio', () => {
  it('records the fresh ML state and clears the stale diagnosis', async () => {
    const res = await POST(req(validBody));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      estado: 'p',
      status: 'active',
      subStatus: [],
      // What the operator actually wants to know: will stock flow again?
      enviavel: true,
    });

    const [, integracaoId, target, item, opts] = h.applyItemStatusToLink.mock.calls[0]!;
    expect(integracaoId).toBe(CONTA);
    expect(target).toEqual({ produtoId: PRODUTO, linkDocId: LINK, itemId: ITEM });
    expect(item).toMatchObject({ status: 'active' });
    // Clearing `errors` is the whole point — it is what un-latches the sweep.
    expect(opts.extra).toEqual({ errors: [] });
  });

  it('reports a listing ML still refuses stock for, without pretending it is fixed', async () => {
    h.getItem.mockResolvedValue({ id: ITEM, status: 'under_review', sub_status: [] });

    const res = await POST(req(validBody));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: 'v', enviavel: false });
  });

  it('records the closed state when the listing is gone (never leaves it active)', async () => {
    h.getItem.mockRejectedValue(new MercadoLivreHttpError('ML 404: not found', 404, null));

    const res = await POST(req(validBody));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      estado: 'c',
      status: 'closed',
      subStatus: [],
      enviavel: false,
    });
    const [, , , item] = h.applyItemStatusToLink.mock.calls[0]!;
    expect(item).toEqual({ status: 'closed', sub_status: [] });
  });

  it('404s for a link that belongs to another conta (body is never trusted alone)', async () => {
    seedLink({ contaOuterRef: 'documents/integracao/OUTRA', id: ITEM });

    const res = await POST(req(validBody));

    expect(res.status).toBe(404);
    expect(h.applyItemStatusToLink).not.toHaveBeenCalled();
    expect(h.getItem).not.toHaveBeenCalled();
  });

  it('404s when the link doc does not exist', async () => {
    seedLink(null);
    expect((await POST(req(validBody))).status).toBe(404);
    expect(h.getItem).not.toHaveBeenCalled();
  });

  it('409s for a listing that was never published (no ML item id)', async () => {
    seedLink({ contaOuterRef: `documents/integracao/${CONTA}`, id: null });
    expect((await POST(req(validBody))).status).toBe(409);
    expect(h.getItem).not.toHaveBeenCalled();
  });

  it('400s on missing fields, invalid JSON and non-object bodies', async () => {
    expect((await POST(req({ integracaoId: CONTA, produtoId: PRODUTO }))).status).toBe(400);
    expect((await POST(req({ integracaoId: CONTA, linkDocId: LINK }))).status).toBe(400);
    expect((await POST(req('{not json'))).status).toBe(400);
    expect((await POST(req('null'))).status).toBe(400);
    expect((await POST(req('[]'))).status).toBe(400);
    expect(h.applyItemStatusToLink).not.toHaveBeenCalled();
  });

  it('400s on truthy NON-STRING fields — a client error must not surface as a 500', async () => {
    // `linkDocId: 1` passes a `!value` guard and then throws inside `.doc(id)`
    // ("not a valid resource path"). This is an authenticated write route, so the
    // types are checked before any value reaches Firestore.
    const cases = [
      { integracaoId: 1, produtoId: PRODUTO, linkDocId: LINK },
      { integracaoId: CONTA, produtoId: { $ne: null }, linkDocId: LINK },
      { integracaoId: CONTA, produtoId: PRODUTO, linkDocId: ['a'] },
      { integracaoId: CONTA, produtoId: PRODUTO, linkDocId: '' },
      { integracaoId: true, produtoId: PRODUTO, linkDocId: LINK },
    ];
    for (const body of cases) {
      expect((await POST(req(body))).status).toBe(400);
    }
    expect(h.applyItemStatusToLink).not.toHaveBeenCalled();
  });

  it('is gated on the caller permission — nothing is read or written on a reject', async () => {
    h.verifyCaller.mockResolvedValue({
      error: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });

    expect((await POST(req(validBody))).status).toBe(403);
    expect(h.docRef).not.toHaveBeenCalled();
    expect(h.applyItemStatusToLink).not.toHaveBeenCalled();
  });
});
