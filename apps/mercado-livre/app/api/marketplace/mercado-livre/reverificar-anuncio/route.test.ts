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
  getLastModeration: vi.fn(),
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
  h.createApi.mockReturnValue({ getItem: h.getItem, getLastModeration: h.getLastModeration });
  // ML's answer for a listing with no active moderation. The DEFAULT, so every
  // test that does not opt in runs the real "not moderated" path (#1087).
  h.getLastModeration.mockRejectedValue(new MercadoLivreHttpError('ML 404: not found', 404, null));
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
    // `causas` goes with it: a surviving cause would keep painting a red field
    // on a listing ML has just confirmed healthy. `moderacoes` likewise (#1087).
    expect(opts.extra).toEqual({ errors: [], causas: [], moderacoes: [] });
    // A healthy `active` listing is never worth a moderation call.
    expect(h.getLastModeration).not.toHaveBeenCalled();
  });

  it('reports a listing ML still refuses stock for, without pretending it is fixed', async () => {
    h.getItem.mockResolvedValue({ id: ITEM, status: 'under_review', sub_status: [] });

    const res = await POST(req(validBody));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: 'v', enviavel: false });
  });

  /**
   * #1087. The re-check clears `errors`/`causas` UNCONDITIONALLY — that is its
   * whole design, the operator saying "tell me the truth now". Left at that,
   * pressing the button on a genuinely moderated listing would erase the reason
   * they pressed it to see and leave a bare "pausado", with the next `items`
   * delivery the only way back — and for a listing nobody touches, that delivery
   * never comes. So a re-check FETCHES rather than merely clearing.
   */
  it('re-fetches the moderation instead of clearing it away', async () => {
    h.getItem.mockResolvedValue({
      id: ITEM,
      status: 'under_review',
      sub_status: ['waiting_for_patch'],
    });
    h.getLastModeration.mockResolvedValue([
      {
        name: 'PICTURE_QUALITY',
        id: '7123400815',
        date_created: '2021-04-14T10:47:05.270-0400',
        evidences: [{ text_matched: 'MLB5095421681', section_name: 'pictures' }],
        wordings: [
          { type: 'REASON', value: 'Pausamos o anúncio porque ele infringe nossas políticas.' },
          { type: 'REMEDY', value: 'Ajuste o título e/ou substitua as fotos.' },
        ],
      },
    ]);

    await POST(req(validBody));

    // The reference id is the item id plus ML's `-ITM` element suffix, never bare.
    expect(h.getLastModeration).toHaveBeenCalledWith(`${ITEM}-ITM`);
    const [, , , , opts] = h.applyItemStatusToLink.mock.calls[0]!;
    expect(opts.extra.errors).toEqual([]);
    expect(opts.extra.moderacoes).toEqual([
      {
        nome: 'PICTURE_QUALITY',
        dataCriacao: '2021-04-14T10:47:05.270-0400',
        motivo: 'Pausamos o anúncio porque ele infringe nossas políticas.',
        remedio: 'Ajuste o título e/ou substitua as fotos.',
        secoes: ['pictures'],
        evidencias: ['MLB5095421681'],
      },
    ]);
  });

  /**
   * Nothing was confirmed, so nothing may be recorded — the same rule the 5xx
   * branch of `getItem` already follows. Writing `moderacoes: []` after a failed
   * read would record "not moderated", which is indistinguishable from healthy.
   */
  it('records NOTHING when the moderation read fails transiently', async () => {
    h.getItem.mockResolvedValue({ id: ITEM, status: 'under_review', sub_status: [] });
    h.getLastModeration.mockRejectedValue(new MercadoLivreHttpError('ML 500: boom', 500, null));

    const res = await POST(req(validBody));

    expect(res.status).toBe(502);
    expect(h.applyItemStatusToLink).not.toHaveBeenCalled();
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
    const [, , , item, opts] = h.applyItemStatusToLink.mock.calls[0]!;
    expect(item).toEqual({ status: 'closed', sub_status: [] });
    // A moderation on a listing that no longer exists explains nothing, and ML
    // would 404 for it too — one of only two places allowed to blank the field
    // without having read it.
    expect(opts.extra).toEqual({ errors: [], causas: [], moderacoes: [] });
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
