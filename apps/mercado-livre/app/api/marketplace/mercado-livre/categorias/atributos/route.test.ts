import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  getCategory: vi.fn(),
  getCategoryAttributes: vi.fn(),
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
  return {
    ...actual,
    createMercadoLivreApi: () => ({
      getCategory: h.getCategory,
      getCategoryAttributes: h.getCategoryAttributes,
    }),
  };
});

const { GET } = await import('./route');

const req = (qs: string) =>
  new Request(`http://localhost:3006/api/marketplace/mercado-livre/categorias/atributos${qs}`);

const LEAF = '?integracaoId=int-1&categoryId=MLB31447';

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllReadCaches();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.resolveChannelContext.mockResolvedValue({ integracaoId: 'i', accessToken: 'AT', account: {} });
  h.loadCtx.mockResolvedValue({ resolveChannelContext: h.resolveChannelContext });
  h.getCategory.mockResolvedValue({ id: 'MLB31447', children_categories: [] });
  h.getCategoryAttributes.mockResolvedValue([
    { id: 'BRAND', name: 'Marca', value_type: 'string', tags: { required: true } },
    // A required attribute that IS editable, so the required-first ordering
    // below still has two rows to order. BRAND used to play that part and no
    // longer reaches `atributos` at all — it is `herdado`, filled from the
    // produto's Marca.
    { id: 'MATERIAL', name: 'Material', value_type: 'string', tags: { required: true } },
    { id: 'MODEL', name: 'Modelo', value_type: 'string', relevance: 2 },
    { id: 'SELLER_SKU', name: 'SKU', value_type: 'string' },
    { id: 'ESCONDIDO', name: 'Oculto', value_type: 'string', tags: { hidden: true } },
    { id: 'SIZE_GRID_ID', name: 'Grade', value_type: 'grid_id' },
    { id: 'SLEEVE', name: 'Manga', value_type: 'list', tags: { variation_attribute: true } },
  ]);
});

describe('GET /api/marketplace/mercado-livre/categorias/atributos', () => {
  it('rejects an unauthorized caller', async () => {
    h.verifyCaller.mockResolvedValue({ error: new Response(null, { status: 403 }) });
    expect((await GET(req(LEAF))).status).toBe(403);
  });

  it('400s without integracaoId or categoryId', async () => {
    expect((await GET(req('?categoryId=MLB31447'))).status).toBe(400);
    expect((await GET(req('?integracaoId=int-1'))).status).toBe(400);
  });

  it('400s on an unknown escopo', async () => {
    expect((await GET(req(`${LEAF}&escopo=qualquer`))).status).toBe(400);
  });

  it('returns only the editable attributes, required first', async () => {
    const res = await GET(req(LEAF));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      leaf: boolean;
      atributos: Array<{ id: string; required: boolean }>;
      omitidos: Array<{ id: string; motivo: string }>;
    };
    expect(body.leaf).toBe(true);
    expect(body.atributos.map((a) => a.id)).toEqual(['MATERIAL', 'MODEL']);
    expect(body.atributos[0]!.required).toBe(true);
    // ⚠️ BRAND appears in NEITHER array over the wire. `omitidos` is the prune
    // list, so naming it there is what would delete the stored brand — on any
    // apps/web bundle, old or new. Its absence is the mechanism.
    expect(body.omitidos.some((o) => o.id === 'BRAND')).toBe(false);
    expect(body.omitidos).toEqual([
      { id: 'SELLER_SKU', motivo: 'derivado' },
      { id: 'ESCONDIDO', motivo: 'oculto' },
      { id: 'SIZE_GRID_ID', motivo: 'tabela-de-medidas' },
      { id: 'SLEEVE', motivo: 'somente-variacao' },
    ]);
  });

  it('escopo=variacao returns a different set, not a subset', async () => {
    const body = (await (await GET(req(`${LEAF}&escopo=variacao`))).json()) as {
      atributos: Array<{ id: string }>;
    };
    expect(body.atributos.map((a) => a.id)).toEqual(['SLEEVE']);
  });

  it('short-circuits a mid-tree category WITHOUT the expensive attributes call', async () => {
    h.getCategory.mockResolvedValue({
      id: 'MLB1430',
      children_categories: [{ id: 'MLB31447' }],
    });
    const res = await GET(req('?integracaoId=int-1&categoryId=MLB1430'));
    expect(await res.json()).toEqual({ leaf: false, atributos: [], omitidos: [] });
    expect(h.getCategoryAttributes).not.toHaveBeenCalled();
  });

  it('serves a repeat request from the cache', async () => {
    await GET(req(LEAF));
    await GET(req(LEAF));
    expect(h.getCategoryAttributes).toHaveBeenCalledTimes(1);
  });

  it('maps an ML failure to the shared error response', async () => {
    h.getCategoryAttributes.mockRejectedValue(new MercadoLivreHttpError('boom', 500, {}));
    expect((await GET(req(LEAF))).status).toBe(502);
  });
});
