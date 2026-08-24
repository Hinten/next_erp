import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

// verifyCaller / the context loader / the ML client are mocked; the route's own
// logic (body validation, ownership check, 409 vs 404, error mapping) runs for
// real, and so does `resolveAnuncioUrl`.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  createApi: vi.fn(),
  getUserProductFamily: vi.fn(),
  searchItemsByUserProduct: vi.fn(),
  getItem: vi.fn(),
  docRef: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/core/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/core/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
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
const FAMILIA = '6264141844942250';
const SELLER = 4242;

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/link-anuncio', {
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
  h.loadCtx.mockResolvedValue({
    // The família branch searches items under the conta's own ML id.
    conta: { user_id: SELLER },
    resolveChannelContext: h.resolveChannelContext,
  });
  h.createApi.mockReturnValue({
    getUserProductFamily: h.getUserProductFamily,
    searchItemsByUserProduct: h.searchItemsByUserProduct,
    getItem: h.getItem,
  });
  h.getUserProductFamily.mockResolvedValue({ user_products_ids: ['MLBU1'] });
  h.searchItemsByUserProduct.mockResolvedValue({ results: ['MLB999'] });
  h.getItem.mockResolvedValue({ id: 'MLB999', permalink: 'https://ml/MLB999' });
  seedLink({
    contaOuterRef: `documents/integracao/${CONTA}`,
    id: FAMILIA,
    isUserProductModel: true,
  });
});

describe('POST /api/marketplace/mercado-livre/link-anuncio', () => {
  it('answers a buyable ITEM page for a User-Products family', async () => {
    const res = await POST(req(validBody));

    expect(res.status).toBe(200);
    // The item's own permalink — never `/up/<MLBU>`, which names a product with
    // no sale condition and renders indisponível.
    expect(await res.json()).toEqual({ url: 'https://ml/MLB999' });
    expect(h.getUserProductFamily).toHaveBeenCalledWith(FAMILIA);
    expect(h.searchItemsByUserProduct).toHaveBeenCalledWith(SELLER, ['MLBU1'], {
      limit: 1,
      offset: 0,
      status: 'active',
    });
  });

  it('409s when the conta carries no ML user_id', async () => {
    // A connection that never identified itself, not a dead anúncio — 404 would
    // send the operator hunting for a listing that is fine.
    h.loadCtx.mockResolvedValue({
      conta: { user_id: null },
      resolveChannelContext: h.resolveChannelContext,
    });

    const res = await POST(req(validBody));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('user_id');
    expect(h.getUserProductFamily).not.toHaveBeenCalled();
  });

  it('answers a legacy listing without asking ML anything', async () => {
    seedLink({
      contaOuterRef: `documents/integracao/${CONTA}`,
      id: 'MLB777',
      isUserProductModel: false,
    });

    const res = await POST(req(validBody));

    expect(await res.json()).toEqual({ url: 'https://produto.mercadolivre.com.br/MLB-777' });
    expect(h.getUserProductFamily).not.toHaveBeenCalled();
    expect(h.getItem).not.toHaveBeenCalled();
  });

  it('404s when ML says the listing is gone', async () => {
    // Distinct from the 409 below: `id` IS set, so this listing was published —
    // it just no longer exists, and there is no page to open.
    const gone = new MercadoLivreHttpError('ML 404: not found', 404, null);
    h.getUserProductFamily.mockRejectedValue(gone);
    h.searchItemsByUserProduct.mockRejectedValue(gone);
    h.getItem.mockRejectedValue(gone);

    expect((await POST(req(validBody))).status).toBe(404);
  });

  it('maps an ML failure instead of throwing a 500', async () => {
    h.getUserProductFamily.mockRejectedValue(
      new MercadoLivreHttpError('ML 502: bad gateway', 502, null),
    );

    const res = await POST(req(validBody));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });

  it('404s for a link that belongs to another conta (body is never trusted alone)', async () => {
    seedLink({ contaOuterRef: 'documents/integracao/OUTRA', id: FAMILIA });

    expect((await POST(req(validBody))).status).toBe(404);
    expect(h.getUserProductFamily).not.toHaveBeenCalled();
  });

  it('404s when the link doc does not exist', async () => {
    seedLink(null);
    expect((await POST(req(validBody))).status).toBe(404);
    expect(h.getUserProductFamily).not.toHaveBeenCalled();
  });

  it('409s for a listing that was never published (no ML id)', async () => {
    seedLink({ contaOuterRef: `documents/integracao/${CONTA}`, id: null });
    expect((await POST(req(validBody))).status).toBe(409);
    expect(h.getUserProductFamily).not.toHaveBeenCalled();
  });

  it('400s on missing fields, invalid JSON and non-object bodies', async () => {
    expect((await POST(req({ integracaoId: CONTA, produtoId: PRODUTO }))).status).toBe(400);
    expect((await POST(req({ integracaoId: CONTA, linkDocId: LINK }))).status).toBe(400);
    expect((await POST(req('{not json'))).status).toBe(400);
    expect((await POST(req('null'))).status).toBe(400);
    expect((await POST(req('[]'))).status).toBe(400);
    expect(h.docRef).not.toHaveBeenCalled();
  });

  it('400s on truthy NON-STRING fields — a client error must not surface as a 500', async () => {
    // `linkDocId: 1` passes a `!value` guard and then throws inside `.doc(id)`
    // ("not a valid resource path").
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
    expect(h.docRef).not.toHaveBeenCalled();
  });

  it('is gated on the caller permission — nothing is read on a reject', async () => {
    h.verifyCaller.mockResolvedValue({
      error: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });

    expect((await POST(req(validBody))).status).toBe(403);
    expect(h.docRef).not.toHaveBeenCalled();
  });
});
