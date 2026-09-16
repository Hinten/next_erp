import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  shopeeCategoriaSchema,
  shopeeItemBaseInfoPayloadSchema,
  shopeeKitItemInfoPayloadSchema,
  type ShopeeCategoria,
} from '@delfrance/integrations-shopee';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { MSG_ITEM_ID_STRING } from '@/lib/shopee/produtos/corpoImportacao';
import { MOTIVO_IMPORT_BLOQUEADO } from '@/lib/shopee/produtos/errosImportacao';
import { limparTaxonomiaShopee } from '@/lib/shopee/taxonomia/cache';
import { FakeDb, asDb } from '@/lib/shopee/testing/fakeDb';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  getItemBaseInfo: vi.fn(),
  getModelList: vi.fn(),
  getKitItemInfo: vi.fn(),
  getCategory: vi.fn(),
  importarKit: vi.fn(),
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
  // Sem bucket resolvível as fotos são puladas — e nenhum teste daqui as quer.
  tryGetAdminBucket: () => null,
}));

vi.mock('@/lib/shopee/core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

// O braço de kit é da metade W desta onda; aqui só se prova o ROTEAMENTO.
vi.mock('@/lib/shopee/produtos/kitShopee', () => ({ importarKitShopee: h.importarKit }));

const { POST } = await import('./route');

const INT_A = 'int-1';
const ITEM_ID = 2500139861;
const TABELA_NORMAL = 'documents/listaDePrecos/tab-normal';
const DEPOSITO = 'documents/depositos/dep-1';

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

/** `Roupas > Camisetas > Manga Curta` — três documentos de cadeia. */
const ARVORE: ShopeeCategoria[] = [
  { category_id: 100001, parent_category_id: 0, display_category_name: 'Roupas' },
  { category_id: 100009, parent_category_id: 100001, display_category_name: 'Camisetas' },
  { category_id: 100017, parent_category_id: 100009, display_category_name: 'Manga Curta' },
].map((c) => shopeeCategoriaSchema.parse({ has_children: false, ...c }));

const LINHA_SIMPLES = {
  item_id: ITEM_ID,
  item_name: 'Camiseta Básica',
  item_sku: 'CAM-001',
  category_id: 100017,
  weight: '0.5',
  price_info: [{ currency: 'BRL', original_price: 99.9, current_price: 49.9 }],
  stock_info_v2: { seller_stock: [{ location_id: 'BR', stock: 7, if_saleable: true }] },
};

function payload(...linhas: Record<string, unknown>[]) {
  return shopeeItemBaseInfoPayloadSchema.parse({ item_list: linhas });
}

function req(corpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/importar', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function corpoValido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { integracaoId: INT_A, itemId: ITEM_ID, options: { importarFotos: false }, ...over };
}

function ctxDouble() {
  return {
    integracaoId: INT_A,
    conta: {
      tipo: 9,
      tabelaNormalOuterRef: TABELA_NORMAL,
      tabelaPromocionalOuterRef: null,
      depositoOuterRef: DEPOSITO,
    },
    createShopClient: () => ({
      getItemBaseInfo: h.getItemBaseInfo,
      getModelList: h.getModelList,
      getKitItemInfo: h.getKitItemInfo,
      getCategory: h.getCategory,
    }),
  };
}

let db: FakeDb;
let spyWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  limparTaxonomiaShopee();
  db = new FakeDb();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  h.loadCtx.mockResolvedValue(ctxDouble());
  h.getItemBaseInfo.mockResolvedValue(payload(LINHA_SIMPLES));
  h.getCategory.mockResolvedValue({ category_list: ARVORE });
  spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  limparTaxonomiaShopee();
  spyWarn.mockRestore();
});

describe('autenticação e corpo', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await POST(req(corpoValido()))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(403);
  });

  it('responde 400 para um body JSON malformado, sem chamar a Shopee', async () => {
    const res = await POST(req('{"integracaoId":', AUTORIZADO));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Body JSON inválido.' });
    expect(h.getItemBaseInfo).not.toHaveBeenCalled();
  });

  it('⛔ responde 400 para um itemId em forma de string', async () => {
    // Um id em string não casa NADA no composto do `prodshopee`: aceitar aqui
    // cadastraria um segundo produto para um anúncio que o ERP já tem.
    const res = await POST(req(corpoValido({ itemId: String(ITEM_ID) }), AUTORIZADO));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: MSG_ITEM_ID_STRING });
    expect(db.writes).toHaveLength(0);
  });

  it('responde 400 com o código do status recusado', async () => {
    const res = await POST(
      req(corpoValido({ options: { statuses: ['SHOPEE_DELETE'] } }), AUTORIZADO),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'SHOPEE_IMPORT_STATUS_RECUSADO' });
  });
});

describe('os erros da conta e do anúncio', () => {
  it('uma conta inexistente ou de outro tipo responde 404', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('Integração int-1 não existe.'));

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(404);
    expect(h.getItemBaseInfo).not.toHaveBeenCalled();
  });

  it('um anúncio bloqueado vira 422 com o motivo, sem escrever nada', async () => {
    h.getItemBaseInfo.mockResolvedValue(payload());

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      code: 'SHOPEE_IMPORT_BLOCKED',
      motivo: MOTIVO_IMPORT_BLOQUEADO.itemNaoEncontrado,
      itemId: ITEM_ID,
    });
    expect(db.writes).toHaveLength(0);
  });

  it('deixa um erro alheio subir (regra 6)', async () => {
    h.getItemBaseInfo.mockRejectedValue(new TypeError('bug nosso'));

    await expect(POST(req(corpoValido(), AUTORIZADO))).rejects.toBeInstanceOf(TypeError);
  });
});

describe('o caminho completo, sobre o FakeDb real e o importador real', () => {
  it('cadastra o produto, o vínculo e a linha de estoque', async () => {
    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { produtoId: string; criado: boolean; nome: string };
    expect(corpo).toMatchObject({ criado: true, nome: 'Camiseta Básica' });

    const paiId = corpo.produtoId;
    expect(db.store[`produtos/${paiId}`]).toBeDefined();
    expect(
      db.writes.some((w) => w.path.startsWith(`produtos/${paiId}/prodshopee/`)),
      'o vínculo prodshopee foi gravado',
    ).toBe(true);
    expect(
      db.writes.some((w) => w.path.startsWith(`produtos/${paiId}/estoques/`)),
      'a linha de estoque foi gravada',
    ).toBe(true);
  });

  it('o corpo 200 carrega só os campos do resultado, e nenhum kit para um anúncio comum', async () => {
    const corpo = (await (await POST(req(corpoValido(), AUTORIZADO))).json()) as Record<
      string,
      unknown
    >;

    expect(Object.keys(corpo).sort()).toEqual([
      'criado',
      'fotos',
      'nome',
      'produtoId',
      'variacoes',
    ]);
  });

  it('⛔ a rota PASSA o memo de categorias — sem ele a perna de categoria some em silêncio', async () => {
    // `categorias` ausente não é um erro: a perna é pulada com uma linha de log
    // e o produto sai sem categoria nenhuma, o que se parece com um import
    // correto. É por isso que o memo é obrigatório na montagem das deps.
    await POST(req(corpoValido(), AUTORIZADO));

    expect(h.getCategory).toHaveBeenCalled();
    expect(
      db.writes.some((w) => w.path.startsWith('categorias/')),
      'a cadeia de categorias foi criada',
    ).toBe(true);
  });

  it('um anúncio SEM modelos não pede get_model_list', async () => {
    await POST(req(corpoValido(), AUTORIZADO));

    expect(h.getItemBaseInfo).toHaveBeenCalledTimes(1);
    expect(h.getModelList).not.toHaveBeenCalled();
    expect(h.getKitItemInfo).not.toHaveBeenCalled();
  });
});

describe('um kit vai para o importador de kit', () => {
  it('roteia por tag.kit e devolve o bloco kit do resultado', async () => {
    h.getItemBaseInfo.mockResolvedValue(payload({ ...LINHA_SIMPLES, tag: { kit: true } }));
    h.getKitItemInfo.mockResolvedValue(
      shopeeKitItemInfoPayloadSchema.parse({
        product_info: { item_id: ITEM_ID, item_name: 'Kit de Camisetas' },
      }),
    );
    h.importarKit.mockResolvedValue({
      produtoId: 'p-kit',
      criado: true,
      nome: 'Kit de Camisetas',
      variacoes: { total: 0, criadas: 0, semLink: 0 },
      fotos: { importadas: 0, ignoradas: 0, falhas: 0 },
      kit: { componentes: 3, criado: true },
    });

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      produtoId: 'p-kit',
      kit: { componentes: 3, criado: true },
    });
    expect(h.importarKit).toHaveBeenCalledTimes(1);
    // ⛔ O kit NUNCA passa pelo get_model_list.
    expect(h.getModelList).not.toHaveBeenCalled();
  });
});
