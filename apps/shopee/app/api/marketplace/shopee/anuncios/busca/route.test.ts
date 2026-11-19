import { PERM } from '@delfrance/auth';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_ITEM_STATUS_WIRE,
  SHOPEE_SEARCH_ITEM_PATH,
  ShopeeApiError,
  shopeeItemBaseInfoPayloadSchema,
} from '@delfrance/integrations-shopee';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';

const h = vi.hoisted(() => ({
  db: { nome: 'db' },
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  searchItem: vi.fn(),
  getItemBaseInfo: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));

vi.mock('@/lib/shopee/core/shopee', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/shopee/core/shopee')>()),
  loadShopeeContext: h.loadCtx,
}));

const { GET } = await import('./route');

function req(params: Record<string, string>, token = 'teste'): Request {
  const url = new URL('http://localhost:3009/api/marketplace/shopee/anuncios/busca');
  url.search = new URLSearchParams({ integracaoId: 'conta-a', ...params }).toString();
  return new Request(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

function base(...itens: unknown[]) {
  return shopeeItemBaseInfoPayloadSchema.parse({ item_list: itens });
}

function falhaShopee(code: string, providerMessage: string) {
  return new ShopeeApiError('Erro na consulta à Shopee.', {
    code,
    providerMessage,
    kind: SHOPEE_ERROR_KIND.other,
    httpStatus: 200,
    path: SHOPEE_SEARCH_ITEM_PATH,
  });
}

describe('GET /anuncios/busca', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.verifyIdToken.mockResolvedValue({
      uid: 'operador',
      permissions: PERM.integracao.write.toString(),
    });
    h.loadCtx.mockResolvedValue({
      createShopClient: () => ({ searchItem: h.searchItem, getItemBaseInfo: h.getItemBaseInfo }),
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('requires integration write permission before loading the account', async () => {
    expect((await GET(req({ modo: 'id', termo: '42' }, ''))).status).toBe(401);
    h.verifyIdToken.mockResolvedValue({
      uid: 'leitor',
      permissions: PERM.integracao.read.toString(),
    });
    expect((await GET(req({ modo: 'id', termo: '42' }))).status).toBe(403);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '42.1', '4e2', '9007199254740992', ' '])(
    'rejects invalid ID %j before loading the account',
    async (termo) => {
      expect((await GET(req({ modo: 'id', termo }))).status).toBe(400);
      expect(h.loadCtx).not.toHaveBeenCalled();
    },
  );

  it.each<Record<string, string>>([
    { modo: 'outro', termo: 'x' },
    { modo: 'sku', termo: ' ' },
    { modo: 'id', termo: '42', cursor: 'abc' },
  ])('rejects invalid search %j before loading the account', async (params) => {
    expect((await GET(req(params))).status).toBe(400);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('reads the exact numeric ID on the selected account and projects only the listing fields', async () => {
    h.getItemBaseInfo.mockResolvedValue(
      base(
        { item_id: 42, item_name: 'Vestido', item_sku: 'V-1' },
        { item_id: 44, item_name: 'Outra peça' },
      ),
    );
    const res = await GET(req({ integracaoId: 'conta-b', modo: 'id', termo: ' 42 ' }));

    expect(res.status).toBe(200);
    expect(h.loadCtx).toHaveBeenCalledExactlyOnceWith(h.db, 'conta-b');
    expect(h.searchItem).not.toHaveBeenCalled();
    expect(h.getItemBaseInfo).toHaveBeenCalledExactlyOnceWith({ itemIds: [42] });
    await expect(res.json()).resolves.toEqual({
      resultados: [{ itemId: 42, nome: 'Vestido', sku: 'V-1' }],
      proximoCursor: null,
    });
  });

  it.each(['error_item_not_found', 'product.error_item_not_found'])(
    'returns an empty result for %s when an item is missing from the selected shop',
    async (code) => {
      h.getItemBaseInfo.mockRejectedValue(falhaShopee(code, 'Product not found'));
      const res = await GET(req({ modo: 'id', termo: '42' }));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ resultados: [], proximoCursor: null });
    },
  );

  it('uses the listing SKU and excludes stale hits and case-sensitive near-matches', async () => {
    h.searchItem.mockResolvedValue({ item_id_list: [42, 43, 44], next_offset: '' });
    h.getItemBaseInfo.mockResolvedValue(
      base(
        { item_id: 42, item_name: 'Vestido', item_sku: ' V-1 ' },
        { item_id: 43, item_name: 'Saia', item_sku: 'v-1' },
        { item_id: 44, item_name: 'Vestido longo', item_sku: 'V-11' },
      ),
    );
    const res = await GET(req({ modo: 'sku', termo: ' V-1 ' }));

    expect(res.status).toBe(200);
    expect(h.searchItem).toHaveBeenCalledExactlyOnceWith({
      itemSku: 'V-1',
      pageSize: 20,
      offset: undefined,
    });
    await expect(res.json()).resolves.toEqual({
      resultados: [{ itemId: 42, nome: 'Vestido', sku: 'V-1' }],
      proximoCursor: null,
    });
  });

  it('passes the name and cursor verbatim after trimming the name, and hydrates IDs in search order', async () => {
    h.searchItem.mockResolvedValue({ item_id_list: [43, 42, 42, 44, 45], next_offset: 'next+=/?' });
    h.getItemBaseInfo.mockResolvedValue(
      base(
        { item_id: 42, item_name: 'Regata Azul', item_sku: 'A-1' },
        { item_id: 43, item_name: 'Regata Azul Marinho' },
        {
          item_id: 44,
          item_name: 'Regata apagada',
          item_status: SHOPEE_ITEM_STATUS_WIRE.sellerDelete,
        },
      ),
    );
    const res = await GET(req({ modo: 'nome', termo: '  Regata Azul  ', cursor: 'current+=/?' }));

    expect(res.status).toBe(200);
    expect(h.searchItem).toHaveBeenCalledExactlyOnceWith({
      itemName: 'Regata Azul',
      pageSize: 20,
      offset: 'current+=/?',
    });
    expect(h.getItemBaseInfo).toHaveBeenCalledExactlyOnceWith({ itemIds: [43, 42, 44, 45] });
    await expect(res.json()).resolves.toEqual({
      resultados: [
        { itemId: 43, nome: 'Regata Azul Marinho', sku: null },
        { itemId: 42, nome: 'Regata Azul', sku: 'A-1' },
      ],
      proximoCursor: 'next+=/?',
    });
  });

  it('skips hydration on an empty page and stops a repeated cursor', async () => {
    h.searchItem.mockResolvedValue({ item_id_list: [], next_offset: 'repetido' });
    const res = await GET(req({ modo: 'nome', termo: 'Regata', cursor: 'repetido' }));
    await expect(res.json()).resolves.toEqual({ resultados: [], proximoCursor: null });
    expect(h.getItemBaseInfo).not.toHaveBeenCalled();
  });

  it('distinguishes a documented empty search from a parameter or authorization failure', async () => {
    h.searchItem.mockRejectedValueOnce(
      falhaShopee('product.error_param', 'The information you queried is not found.'),
    );
    const busca = req({ modo: 'sku', termo: 'V-1' });
    expect((await GET(busca)).status).toBe(200);

    h.searchItem.mockRejectedValueOnce(falhaShopee('product.error_param', 'parameter invalid'));
    expect((await GET(busca)).status).toBe(502);

    h.loadCtx.mockRejectedValueOnce(new ShopeeContaNotConfiguredError('Conta Shopee indisponível'));
    expect((await GET(busca)).status).toBe(404);
    expect(h.getItemBaseInfo).not.toHaveBeenCalled();
  });
});
