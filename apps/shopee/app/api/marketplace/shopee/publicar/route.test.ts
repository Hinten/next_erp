import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_ITEM_STATUS_WRITABLE,
  SHOPEE_LOGISTICS_FEE_TYPE,
  ShopeeRateLimitError,
  shopeeLogisticsChannelSchema,
  type ShopeeCategoria,
} from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';

import {
  ETAPA_PUBLICACAO,
  MOTIVO_PROBLEMA_PUBLICACAO,
  MOTIVO_PUBLICACAO_BLOQUEADA,
  ShopeePublishRejectedError,
} from '@/lib/shopee/anuncios/errosPublicacao';
import {
  MSG_OPCOES_DE_KIT_EXCLUSIVAS,
  MSG_PRODUTO_ID_INVALIDO,
  MSG_RECRIAR_SEM_LINK,
} from '@/lib/shopee/anuncios/corpoPublicacao';
import type { ResultadoPublicacao } from '@/lib/shopee/anuncios/publicarAnuncio';
import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { MENSAGEM_KIT_INCERTO, type ResultadoPublicacaoKit } from '@/lib/shopee/kits/resultadoKit';
import {
  __setShopeeTaxonomiaClockForTests,
  limparTaxonomiaShopee,
} from '@/lib/shopee/taxonomia/cache';
import { FakeDb, asDb } from '@/lib/shopee/testing/fakeDb';

type ModuloPublicar = typeof import('@/lib/shopee/anuncios/publicarAnuncio');
type ModuloKit = typeof import('@/lib/shopee/kits/publicarKit');

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  publicar: vi.fn(),
  publicarKit: vi.fn(),
  getCategory: vi.fn(),
  getItemLimit: vi.fn(),
  getAttributeTree: vi.fn(),
  getChannelList: vi.fn(),
  real: { fn: null as ModuloPublicar['publicarAnuncioShopee'] | null },
  realKit: { fn: null as ModuloKit['publicarKitShopee'] | null },
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
  tryGetAdminBucket: () => null,
}));

vi.mock('@/lib/shopee/core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

// ⚠️ O default deste espião é o publicador REAL — os casos de 404, de bloqueio e
// de precedência de categoria rodam a função de verdade sobre o FakeDb. Só os
// dois casos que exigiriam um `add_item` de verdade (o 200 e a recusa da própria
// Shopee) o substituem por um valor, porque a rota não tem costura de resolvedor
// de imagens e um publish completo pediria um upload real.
vi.mock('@/lib/shopee/anuncios/publicarAnuncio', async (importActual) => {
  const actual = await importActual<ModuloPublicar>();
  h.real.fn = actual.publicarAnuncioShopee;
  return { ...actual, publicarAnuncioShopee: h.publicar };
});

// Step 19: the native-kit entry, same discipline — the REAL one by default, a
// value only where a real `add_kit_item` would be needed.
vi.mock('@/lib/shopee/kits/publicarKit', async (importActual) => {
  const actual = await importActual<ModuloKit>();
  h.realKit.fn = actual.publicarKitShopee;
  return { ...actual, publicarKitShopee: h.publicarKit };
});

const { POST, CODIGO_ANUNCIO_NAO_ENCONTRADO } = await import('./route');

/* --------------------------------- fixtures ------------------------------- */

const INT_A = 'int-1';
const REF_CONTA = `documents/integracao/${INT_A}`;
const PRODUTO = 'prod-pai';
const FILHO = 'prod-filho';
const LINK = 'link-1';
const ITEM_ID = 2500139861;
const CATEGORIA_DO_LINK = 100_009;
const CATEGORIA_DO_CORPO = 100_017;
const CANAL = 90_003;
const TABELA_NORMAL = 'tab-normal';
const DEPOSITO = 'documents/depositos/dep-1';
const PARTNER_ID = 1_000_001;
const SHOP_ID = 987_654;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

const ARVORE = [
  { category_id: 100_001, parent_category_id: 0, display_category_name: 'Roupas' },
  {
    category_id: CATEGORIA_DO_LINK,
    parent_category_id: 100_001,
    display_category_name: 'Camisetas',
  },
  {
    category_id: CATEGORIA_DO_CORPO,
    parent_category_id: CATEGORIA_DO_LINK,
    display_category_name: 'Manga Curta',
  },
].map((c) => ({ has_children: false, ...c })) as unknown as ShopeeCategoria[];

const BANDAS_DA_LOJA = {
  response: {
    price_limit: { min_limit: 1, max_limit: 1000, min: null, max: null },
    stock_limit: { min_limit: 1, max_limit: 1_000_000, min: null, max: null },
    item_name_length_limit: { min_limit: 10, max_limit: 120, min: null, max: null },
    item_image_count_limit: { min_limit: 1, max_limit: 9, min: null, max: null },
    item_description_length_limit: { min_limit: 20, max_limit: 3000, min: null, max: null },
    dts_limit: {
      days_to_ship_limit: { min_limit: 1, max_limit: 30, min: null, max: null },
      non_pre_order_days_to_ship: 3,
    },
  },
  gtin_limit: { gtin_validation_rule: 'Optional' },
};

const CANAL_DA_LOJA = shopeeLogisticsChannelSchema.parse({
  logistics_channel_id: CANAL,
  enabled: true,
  fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
});

function req(corpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/publicar', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function corpoValido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { integracaoId: INT_A, produtoId: PRODUTO, ...over };
}

function ctxDouble() {
  return {
    integracaoId: INT_A,
    conta: {
      tipo: 9,
      shop_id: SHOP_ID,
      tabelaNormalOuterRef: `documents/listaDePrecos/${TABELA_NORMAL}`,
      depositoOuterRef: DEPOSITO,
      // Sem operação a perna fiscal responde `sem-operacao` com ZERO leituras.
      operacaoOuterRef: null,
    },
    config: { partnerId: PARTNER_ID, partnerKey: 'k', hosts: {}, variationsPath: null },
    createShopClient: () => ({
      getCategory: h.getCategory,
      getItemLimit: h.getItemLimit,
      getAttributeTree: h.getAttributeTree,
      getChannelList: h.getChannelList,
    }),
  };
}

/** Um produto publicável em tudo MENOS nas fotos — o publish bloqueia sozinho. */
function semearProduto(db: FakeDb, over: Record<string, unknown> = {}): void {
  db.seed(`produtos/${PRODUTO}`, {
    nome: 'Camiseta básica branca',
    sku: 'CAM-BR',
    paiId: null,
    pesoBrutoKg: 0.32,
    alturaCm: 2.1,
    larguraCm: 21.4,
    profundidadeCm: 29.2,
    precos: { [TABELA_NORMAL]: { valor: 49.9 } },
    // ⚠️ SEM fotos: o resolvedor real responde lista vazia, nada é enviado e o
    // plano recusa com `sem-fotos` ANTES de qualquer escrita.
    fotos: [],
    ...over,
  });
  db.seed(`produtos/${PRODUTO}/extraData/singleton`, {
    descricao: 'Camiseta de algodão penteado, gola redonda, unissex.',
  });
  db.seed(`produtos/${PRODUTO}/estoques/est-1`, {
    depositoOuterRef: DEPOSITO,
    quantidade: 10,
    quantidadeReservada: 0,
  });
}

function semearLink(db: FakeDb, extra: Record<string, unknown> = {}): void {
  db.seed(`produtos/${PRODUTO}/prodshopee/${LINK}`, {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_name: 'Camiseta básica branca',
    item_id: ITEM_ID,
    brand_id: 0,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    ...extra,
  });
}

/** Um `ResultadoPublicacao` com um campo EXTRA — o corpo 200 não pode vazá-lo. */
function resultadoDouble(): ResultadoPublicacao {
  return {
    plano: { produtoId: PRODUTO, passos: [] },
    produtoId: PRODUTO,
    itemId: ITEM_ID,
    linkDocId: LINK,
    ehAtualizacao: false,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    itemStatus: 'NORMAL',
    deboost: false,
    avisoShopee: 'aviso da shopee',
    modelos: {
      acao: 'init',
      total: 2,
      criados: 2,
      repontados: 0,
      atualizados: 0,
      marcados: 0,
      semFilho: [{ model_id: 111, model_sku: null }],
      desaparecidos: [],
      ignorados: 0,
      avisos: [],
      passos: [],
    },
    fotos: {
      consideradas: 3,
      reutilizadas: 1,
      enviadas: 2,
      falhas: 0,
      descartadasPeloLimite: 0,
    },
    falhasDeFoto: [],
    taxInfoOmitido: null,
    relistagem: null,
    avisoResolvido: false,
    leituraDeVolta: true,
    tabelaDeMedidas: {
      // Shopee's own doc-sample template id — never a real shop's.
      sizeChartId: 700024641,
      fonte: 'modelo',
      motivo: null,
      fotoOmitida: null,
      avisoObrigatoria: false,
      // O eco da releitura é DIAGNÓSTICO (log + CLI) e fica FORA do corpo.
      lidaDeVolta: 700024641,
      fotoLidaDeVolta: true,
      inventadoPelaOndaSeguinte: 'NÃO PODE VAZAR',
    },
    chamadasShopee: 5,
    // Um campo que a onda seguinte poderia acrescentar ao resultado.
    inventadoPelaOndaSeguinte: 'NÃO PODE VAZAR',
  } as unknown as ResultadoPublicacao;
}

let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  limparTaxonomiaShopee();
  __setShopeeTaxonomiaClockForTests();
  db = new FakeDb();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  h.loadCtx.mockResolvedValue(ctxDouble());
  h.getCategory.mockResolvedValue({ category_list: ARVORE });
  h.getItemLimit.mockResolvedValue(BANDAS_DA_LOJA);
  h.getAttributeTree.mockResolvedValue({ list: [] });
  h.getChannelList.mockResolvedValue({ logistics_channel_list: [CANAL_DA_LOJA] });
  h.publicar.mockImplementation((...args: Parameters<ModuloPublicar['publicarAnuncioShopee']>) => {
    if (h.real.fn === null) throw new Error('fixture: o módulo real não foi capturado');
    return h.real.fn(...args);
  });
  h.publicarKit.mockImplementation((...args: Parameters<ModuloKit['publicarKitShopee']>) => {
    if (h.realKit.fn === null) throw new Error('fixture: o módulo real do kit não foi capturado');
    return h.realKit.fn(...args);
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  limparTaxonomiaShopee();
  __setShopeeTaxonomiaClockForTests();
  vi.restoreAllMocks();
});

describe('autenticação e corpo', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await POST(req(corpoValido()))).status).toBe(401);
    expect(h.publicar).not.toHaveBeenCalled();
  });

  it('responde 403 para quem não tem integracao.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(403);
    expect(h.publicar).not.toHaveBeenCalled();
  });

  it('responde 400 para um body JSON malformado, sem publicar nada', async () => {
    const res = await POST(req('{"integracaoId":', AUTORIZADO));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Body JSON inválido.' });
    expect(h.publicar).not.toHaveBeenCalled();
  });

  it('⛔ responde 400 para um produtoId com separador, ANTES de qualquer `.doc(id)`', async () => {
    const res = await POST(req(corpoValido({ produtoId: 'a/b' }), AUTORIZADO));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: MSG_PRODUTO_ID_INVALIDO });
    expect(db.caminhos).toHaveLength(0);
  });
});

describe('a conta e o 404', () => {
  it('uma conta inexistente ou de outro tipo responde 404 pela escada do respond', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('Integração int-1 não existe.'));

    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(404);
  });

  it('um produto que não existe responde 404 com o código do anúncio', async () => {
    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: CODIGO_ANUNCIO_NAO_ENCONTRADO });
    expect(db.writes).toHaveLength(0);
  });

  it('um linkDocId que não é desta conta responde 404, não um primeiro publish', async () => {
    semearProduto(db);
    db.seed(`produtos/${PRODUTO}/prodshopee/${LINK}`, {
      contaProdutoShopeeOuterRef: 'documents/integracao/int-2',
      item_id: ITEM_ID,
    });

    const res = await POST(req(corpoValido({ linkDocId: LINK }), AUTORIZADO));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: CODIGO_ANUNCIO_NAO_ENCONTRADO });
    expect(db.writes).toHaveLength(0);
  });

  it('deixa um erro alheio subir (regra 6)', async () => {
    semearProduto(db);
    h.publicar.mockRejectedValue(new TypeError('bug nosso'));

    await expect(POST(req(corpoValido(), AUTORIZADO))).rejects.toBeInstanceOf(TypeError);
  });
});

describe('as duas recusas por produto', () => {
  it('⛔ um produto que é FILHO vira o bloqueio, com motivo e problemas, sem escrever nada', async () => {
    // O publicador real: `recusarProdutoNaoPublicavel` levanta logo depois da
    // leitura do produto, antes de qualquer chamada à Shopee.
    db.seed(`produtos/${FILHO}`, { nome: 'Camiseta P', paiId: PRODUTO, fotos: [] });

    const res = await POST(req(corpoValido({ produtoId: FILHO }), AUTORIZADO));

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as {
      code: string;
      motivo: string;
      problemas: { campo: string | null; motivo: string }[];
      produtoId: string;
      itemId: number | null;
    };
    expect(corpo.code).toBe('SHOPEE_PUBLISH_BLOCKED');
    expect(corpo.motivo).toBe(MOTIVO_PUBLICACAO_BLOQUEADA.produtoEFilho);
    expect(corpo.problemas[0]).toMatchObject({
      campo: 'paiId',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.produtoEFilho,
    });
    expect(corpo.produtoId).toBe(FILHO);
    expect(corpo.itemId).toBeNull();
    expect(db.writes).toHaveLength(0);
    expect(h.getCategory).not.toHaveBeenCalled();
  });

  it('um produto SEM fotos vira o bloqueio `sem-fotos`, depois da taxonomia e antes de escrever', async () => {
    semearProduto(db);

    const res = await POST(req(corpoValido({ categoryId: CATEGORIA_DO_CORPO }), AUTORIZADO));

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { code: string; problemas: { motivo: string }[] };
    expect(corpo.code).toBe('SHOPEE_PUBLISH_BLOCKED');
    expect(corpo.problemas.map((p) => p.motivo)).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.semFotos);
    expect(db.writes).toHaveLength(0);
  });

  it('uma recusa da própria Shopee vira o REJECTED, com etapa e shopeeCode VERBATIM', async () => {
    semearProduto(db);
    h.publicar.mockRejectedValue(
      new ShopeePublishRejectedError({
        etapa: ETAPA_PUBLICACAO.addItem,
        shopeeCode: 'product.error_param',
        produtoId: PRODUTO,
        itemId: null,
        problemas: [{ campo: 'weight', motivo: 'desconhecido', mensagem: 'peso inválido' }],
      }),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      code: 'SHOPEE_PUBLISH_REJECTED',
      etapa: ETAPA_PUBLICACAO.addItem,
      // ⚠️ Com o prefixo de módulo: a forma limpa é detalhe do classificador.
      shopeeCode: 'product.error_param',
    });
  });

  it('⛔ a rota NÃO re-mapeia os dois 422 — ela importa o `shopeeErrorResponse` e não nomeia nenhum dos dois', () => {
    // A propriedade medida no TEXTO da rota: um `if (err instanceof …) return
    // NextResponse.json({code: …}, {status: 422})` local compila, passa nos
    // testes acima e deixa DUAS casas para uma decisão — e a segunda cópia é a
    // que sai de sincronia quando a escada do `respond.ts` ganha um campo.
    const fonte = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8');

    expect(fonte).toContain('shopeeErrorResponse');
    expect(fonte).not.toContain('SHOPEE_PUBLISH_BLOCKED');
    expect(fonte).not.toContain('SHOPEE_PUBLISH_REJECTED');
    expect(fonte).not.toContain('422');
  });

  it('um limite de rajada da Shopee continua sendo o que o respond diz — não um 422', async () => {
    semearProduto(db);
    h.publicar.mockRejectedValue(
      new ShopeeRateLimitError('rajada', {
        code: 'error_limit',
        kind: SHOPEE_ERROR_KIND.burst,
        httpStatus: 429,
        path: '/api/v2/product/add_item',
      }),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).not.toBe(422);
    expect([502, 503]).toContain(res.status);
  });
});

describe('o 200', () => {
  // The dispatcher reads the produto first (step 19): an absent one is the 404.
  beforeEach(() => semearProduto(db));

  it('⛔ o corpo é montado por NOME — um campo novo no resultado não vaza', async () => {
    h.publicar.mockResolvedValue(resultadoDouble());

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(corpo).sort()).toEqual([
      'avisoShopee',
      'estadoAnuncio',
      'fotos',
      'itemId',
      'itemStatus',
      'modelos',
      'tabelaDeMedidas',
      'taxInfoOmitido',
    ]);
    expect(corpo).toEqual({
      itemId: ITEM_ID,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      itemStatus: 'NORMAL',
      modelos: { total: 2, criados: 2, atualizados: 0, semFilho: 1 },
      fotos: { reutilizadas: 1, enviadas: 2, falhas: 0 },
      avisoShopee: 'aviso da shopee',
      taxInfoOmitido: null,
      tabelaDeMedidas: {
        sizeChartId: 700024641,
        fonte: 'modelo',
        motivo: null,
        fotoOmitida: null,
        avisoObrigatoria: false,
      },
    });
  });

  it('⛔ passo 18: `tabelaDeMedidas` também é por NOME — o eco da releitura e um campo novo ficam fora', async () => {
    h.publicar.mockResolvedValue(resultadoDouble());

    const texto = await (await POST(req(corpoValido(), AUTORIZADO))).text();
    const corpo = JSON.parse(texto) as { tabelaDeMedidas: Record<string, unknown> };

    expect(Object.keys(corpo.tabelaDeMedidas).sort()).toEqual([
      'avisoObrigatoria',
      'fonte',
      'fotoOmitida',
      'motivo',
      'sizeChartId',
    ]);
    expect(texto).not.toContain('lidaDeVolta');
    expect(texto).not.toContain('NÃO PODE VAZAR');
  });

  it('nem os sub-objetos vazam: `modelos` e `fotos` também são por nome', async () => {
    h.publicar.mockResolvedValue(resultadoDouble());

    const corpo = (await (await POST(req(corpoValido(), AUTORIZADO))).json()) as {
      modelos: Record<string, unknown>;
      fotos: Record<string, unknown>;
    };

    expect(Object.keys(corpo.modelos).sort()).toEqual([
      'atualizados',
      'criados',
      'semFilho',
      'total',
    ]);
    // `consideradas` e `descartadasPeloLimite` existem no resumo e NÃO no corpo.
    expect(Object.keys(corpo.fotos).sort()).toEqual(['enviadas', 'falhas', 'reutilizadas']);
  });
});

describe('o relógio e a passagem de parâmetros', () => {
  beforeEach(() => semearProduto(db));

  it('⛔ o `Date.now()` é lido UMA vez por requisição', async () => {
    h.publicar.mockResolvedValue(resultadoDouble());
    const spy = vi.spyOn(Date, 'now');

    await POST(req(corpoValido(), AUTORIZADO));

    // Um segundo relógio faria dois documentos de UM publish discordarem sobre
    // quando ele aconteceu — e a divergência só apareceria num histórico.
    expect(spy).toHaveBeenCalledTimes(1);
    const deps = spy.mock.results.length > 0 ? h.publicar.mock.calls[0]?.[0] : null;
    expect((deps as { nowMs: number }).nowMs).toBe(spy.mock.results[0]?.value);
  });

  it('o status do corpo chega ao publicador como `statusPedido`, e o padrão é NORMAL', async () => {
    h.publicar.mockResolvedValue(resultadoDouble());

    await POST(req(corpoValido(), AUTORIZADO));
    expect(h.publicar.mock.calls[0]?.[1]).toMatchObject({
      produtoId: PRODUTO,
      linkDocId: null,
      categoryId: null,
      statusPedido: SHOPEE_ITEM_STATUS_WRITABLE.normal,
    });

    // The named link must BE this conta's: an unknown one is the dispatcher's 404.
    semearLink(db);
    await POST(
      req(corpoValido({ status: SHOPEE_ITEM_STATUS_WRITABLE.unlist, linkDocId: LINK }), AUTORIZADO),
    );
    expect(h.publicar.mock.calls[1]?.[1]).toMatchObject({
      linkDocId: LINK,
      statusPedido: SHOPEE_ITEM_STATUS_WRITABLE.unlist,
    });
  });

  it('a rota passa o `esperar` e a fábrica do partner client — a pasta não constrói nenhum dos dois', async () => {
    h.publicar.mockResolvedValue(resultadoDouble());

    await POST(req(corpoValido(), AUTORIZADO));

    const deps = h.publicar.mock.calls[0]?.[0] as {
      esperar: (ms: number) => Promise<void>;
      partnerClient: () => unknown;
      taxonomia: { integracaoId: string };
      categorias: { carregar: () => Promise<unknown> };
      operacaoOuterRef: string | null;
    };
    expect(typeof deps.esperar).toBe('function');
    expect(typeof deps.partnerClient).toBe('function');
    expect(deps.taxonomia.integracaoId).toBe(INT_A);
    expect(typeof deps.categorias.carregar).toBe('function');
    expect(deps.operacaoOuterRef).toBeNull();
    // ⚠️ `hostEmulador` é OMITIDO, não `null`: nada neste app escreve uma url de
    // arquivo hospedada no emulador, então não existe fonte para esse valor.
    expect('hostEmulador' in deps).toBe(false);
    await expect(deps.esperar(0)).resolves.toBeUndefined();
  });
});

describe('o categoryId opcional (C36)', () => {
  /** Qual categoria a taxonomia foi consultada com — o id que o publish resolveu. */
  function categoriaConsultada(): number | null {
    const chamada = h.getItemLimit.mock.calls[0]?.[0] as { categoryId?: number } | undefined;
    return chamada?.categoryId ?? null;
  }

  it('sem categoria no vínculo, a do CORPO é a que vale', async () => {
    semearProduto(db);
    semearLink(db, { category_id: null });

    const res = await POST(
      req(corpoValido({ linkDocId: LINK, categoryId: CATEGORIA_DO_CORPO }), AUTORIZADO),
    );

    expect(res.status).toBe(422);
    expect(categoriaConsultada()).toBe(CATEGORIA_DO_CORPO);
  });

  it('⚠️ NEAR-MISS: um vínculo COM categoria IGNORA a do corpo — nunca a sobrescreve', async () => {
    semearProduto(db);
    semearLink(db, { category_id: CATEGORIA_DO_LINK });

    const res = await POST(
      req(corpoValido({ linkDocId: LINK, categoryId: CATEGORIA_DO_CORPO }), AUTORIZADO),
    );

    expect(res.status).toBe(422);
    expect(categoriaConsultada()).toBe(CATEGORIA_DO_LINK);
    expect(categoriaConsultada()).not.toBe(CATEGORIA_DO_CORPO);
  });

  it('o corpo entrega o categoryId VERBATIM ao publicador — nem descartado nem reescrito', async () => {
    semearProduto(db);
    h.publicar.mockResolvedValue(resultadoDouble());

    await POST(req(corpoValido({ categoryId: CATEGORIA_DO_CORPO }), AUTORIZADO));

    expect(h.publicar.mock.calls[0]?.[1]).toMatchObject({ categoryId: CATEGORIA_DO_CORPO });
  });
});

/* ========================================================================== */
/*  Step 19 (PR 7): the kit arms through the route                             */
/* ========================================================================== */

const KIT = 'kit-k';
const KIT_ITEM = 2500139870;
const VINCULO_KIT = 'vinculo-kit';

/** A kit the ERP says the MARKETPLACE resolves (`ehKitVirtualEfetivo`), no link yet ⇒ `kit-criar`. */
function semearKit(): void {
  db.seed(`produtos/${KIT}`, {
    nome: 'Kit camiseta e boné',
    sku: 'KIT-1',
    paiId: null,
    ehKit: true,
    ehKitVirtual: true,
  });
}

/** A `ResultadoPublicacaoKit` with EXTRA fields — the body must not leak them. */
function resultadoKitDouble(over: Partial<ResultadoPublicacaoKit> = {}): ResultadoPublicacaoKit {
  return {
    arma: 'kit-criar',
    desfecho: 'criado',
    produtoId: KIT,
    itemId: KIT_ITEM,
    linkDocId: VINCULO_KIT,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    itemStatus: 'NORMAL',
    kitNativo: true,
    modelos: { vinculados: 2, anexados: 0, semFilho: 0, inventadoPelaOndaSeguinte: 1 },
    antecessor: null,
    avisos: [
      {
        codigo: 'componente-nao-limita-estoque',
        produtoId: 'comp-a',
        mensagem: 'frase em português que fica no CLI e no log',
      },
    ],
    avisosResolvidos: 1,
    chamadasShopee: 9,
    recusa: null,
    comando: null,
    inventadoPelaOndaSeguinte: 'NÃO PODE VAZAR',
    ...over,
  } as unknown as ResultadoPublicacaoKit;
}

const CHAVES_DO_KIT = [
  'antecessor',
  'arma',
  'avisos',
  'avisosResolvidos',
  'comando',
  'desfecho',
  'estadoAnuncio',
  'itemId',
  'itemStatus',
  'kitNativo',
  'linkDocId',
  'modelos',
  'recusa',
];

describe('passo 19 — os braços de kit pela rota', () => {
  it('kit-criar: o 200 é o resumo do kit por NOME — os avisos viram {codigo, produtoId}, nada mais vaza', async () => {
    semearKit();
    h.publicarKit.mockResolvedValue(resultadoKitDouble());

    const res = await POST(req(corpoValido({ produtoId: KIT, principal: 'comp-a' }), AUTORIZADO));

    expect(res.status).toBe(200);
    const texto = await res.text();
    const corpo = JSON.parse(texto) as Record<string, unknown>;
    expect(Object.keys(corpo).sort()).toEqual(CHAVES_DO_KIT);
    expect(corpo).toMatchObject({
      arma: 'kit-criar',
      desfecho: 'criado',
      itemId: KIT_ITEM,
      linkDocId: VINCULO_KIT,
      kitNativo: true,
      modelos: { vinculados: 2, anexados: 0, semFilho: 0 },
      avisos: [{ codigo: 'componente-nao-limita-estoque', produtoId: 'comp-a' }],
      avisosResolvidos: 1,
      recusa: null,
      comando: null,
    });
    expect(Object.keys(corpo.modelos as object).sort()).toEqual([
      'anexados',
      'semFilho',
      'vinculados',
    ]);
    expect(texto).not.toContain('NÃO PODE VAZAR');
    expect(texto).not.toContain('inventadoPelaOndaSeguinte');
    expect(texto).not.toContain('frase em português');
    expect(h.publicar).not.toHaveBeenCalled();
  });

  it('o despacho escolhe kit-criar e a rota repassa principal, o increment e a entrada por NOME', async () => {
    semearKit();
    h.publicarKit.mockResolvedValue(resultadoKitDouble());

    await POST(req(corpoValido({ produtoId: KIT, principal: 'comp-a' }), AUTORIZADO));

    const [deps, entrada, arma] = h.publicarKit.mock.calls[0] ?? [];
    expect(arma).toEqual({ arma: 'kit-criar' });
    expect(entrada).toEqual({
      produtoId: KIT,
      linkDocId: null,
      categoryId: null,
      statusPedido: SHOPEE_ITEM_STATUS_WRITABLE.normal,
      principal: 'comp-a',
    });
    // The aviso counter (L4) is wired HERE, never built under `kits/`.
    expect(typeof (deps as { increment: unknown }).increment).toBe('function');
    expect((deps as { increment: (n: number) => unknown }).increment(1)).toBeDefined();
  });

  it('(M147) um kit-criar `incerto` ⇒ 202 com `recusa`, MENSAGEM_KIT_INCERTO e o `comando` exato', async () => {
    semearKit();
    const comando = `publicar:anuncio --integracao ${INT_A} --produto ${KIT} --principal comp-a`;
    h.publicarKit.mockResolvedValue(
      resultadoKitDouble({
        desfecho: 'incerto',
        itemId: null,
        linkDocId: null,
        estadoAnuncio: null,
        itemStatus: null,
        kitNativo: null,
        modelos: { vinculados: 0, anexados: 0, semFilho: 0 },
        avisos: [],
        avisosResolvidos: 0,
        recusa: {
          codigo: 'product.error_busi',
          fraseShopee: 'Too many connections',
          motivo: MOTIVO_PROBLEMA_PUBLICACAO.instabilidadeShopee,
        },
        comando,
      }),
    );

    const res = await POST(req(corpoValido({ produtoId: KIT, principal: 'comp-a' }), AUTORIZADO));

    expect(res.status).toBe(202);
    const corpo = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(corpo).sort()).toEqual([...CHAVES_DO_KIT, 'mensagem'].sort());
    expect(corpo).toMatchObject({
      desfecho: 'incerto',
      itemId: null,
      linkDocId: null,
      recusa: {
        codigo: 'product.error_busi',
        fraseShopee: 'Too many connections',
        motivo: MOTIVO_PROBLEMA_PUBLICACAO.instabilidadeShopee,
      },
      mensagem: MENSAGEM_KIT_INCERTO,
      comando,
    });
  });

  it('(M147, quase-par) um kit CRIADO é 200 sem `mensagem` — o 202 é só do incerto', async () => {
    semearKit();
    h.publicarKit.mockResolvedValue(resultadoKitDouble());

    const res = await POST(req(corpoValido({ produtoId: KIT }), AUTORIZADO));

    expect(res.status).toBe(200);
    expect('mensagem' in ((await res.json()) as object)).toBe(false);
  });

  it('(cut-note #12) um add_kit_item RECUSADO (nao-criado) ⇒ o REJECTED do respond, etapa add_kit_item, shopeeCode VERBATIM', async () => {
    semearKit();
    h.publicarKit.mockRejectedValue(
      new ShopeePublishRejectedError({
        etapa: ETAPA_PUBLICACAO.addKitItem,
        shopeeCode: 'product.error_busi_cannot_edit_vsku',
        produtoId: KIT,
        itemId: null,
        problemas: [
          {
            campo: null,
            motivo: MOTIVO_PROBLEMA_PUBLICACAO.kitBloqueadoPelaShopee,
            mensagem: 'esta loja não pode criar kits pela API',
          },
        ],
      }),
    );

    const res = await POST(req(corpoValido({ produtoId: KIT, principal: 'comp-a' }), AUTORIZADO));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      code: 'SHOPEE_PUBLISH_REJECTED',
      etapa: ETAPA_PUBLICACAO.addKitItem,
      shopeeCode: 'product.error_busi_cannot_edit_vsku',
      produtoId: KIT,
      problemas: [{ motivo: MOTIVO_PROBLEMA_PUBLICACAO.kitBloqueadoPelaShopee }],
    });
  });

  it('uma recusa do DESPACHO é o 422 BLOCKED, sem uma chamada à Shopee e sem publicador nenhum', async () => {
    semearProduto(db);

    const res = await POST(req(corpoValido({ principal: 'comp-a' }), AUTORIZADO));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      code: 'SHOPEE_PUBLISH_BLOCKED',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.opcaoDeKitEmAnuncioComum,
      problemas: [{ campo: 'principal' }],
    });
    expect(h.publicar).not.toHaveBeenCalled();
    expect(h.publicarKit).not.toHaveBeenCalled();
    expect(h.getCategory).not.toHaveBeenCalled();
    expect(h.getChannelList).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
  });

  it('um vínculo NATIVO vivo ⇒ kit-atualizar nele; --recriar com o --link ⇒ kit-recriar', async () => {
    semearKit();
    db.seed(`produtos/${KIT}/prodshopee/${VINCULO_KIT}`, {
      contaProdutoShopeeOuterRef: REF_CONTA,
      item_id: KIT_ITEM,
      kitNativo: true,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });
    h.publicarKit.mockResolvedValue(resultadoKitDouble({ arma: 'kit-atualizar' }));

    await POST(req(corpoValido({ produtoId: KIT }), AUTORIZADO));
    await POST(
      req(corpoValido({ produtoId: KIT, linkDocId: VINCULO_KIT, recriar: true }), AUTORIZADO),
    );

    expect(h.publicarKit.mock.calls.map((c) => c[2])).toEqual([
      { arma: 'kit-atualizar', linkDocId: VINCULO_KIT },
      { arma: 'kit-recriar', linkDocId: VINCULO_KIT },
    ]);
  });

  it('(PR #1869 review) --recriar com um linkDocId que NÃO é desta conta, num kit nativo VIVO ⇒ 404 nomeando o vínculo — nenhum publicador, nenhuma escrita', async () => {
    semearKit();
    db.seed(`produtos/${KIT}/prodshopee/${VINCULO_KIT}`, {
      contaProdutoShopeeOuterRef: REF_CONTA,
      item_id: KIT_ITEM,
      kitNativo: true,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });
    const digitadoErrado = `${VINCULO_KIT}-x`;

    const res = await POST(
      req(corpoValido({ produtoId: KIT, linkDocId: digitadoErrado, recriar: true }), AUTORIZADO),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: `Nenhum anúncio desta conta para o produto ${KIT} sob o vínculo ${digitadoErrado}.`,
      code: CODIGO_ANUNCIO_NAO_ENCONTRADO,
    });
    expect(h.publicar).not.toHaveBeenCalled();
    expect(h.publicarKit).not.toHaveBeenCalled();
    expect(h.getCategory).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
  });

  it('⛔ quase-par: --recriar com o linkDocId de um anúncio COMUM desta conta ⇒ o 422 opcao-de-kit-em-anuncio-comum no campo recriar', async () => {
    semearProduto(db);
    semearLink(db, { kitNativo: false });

    const res = await POST(req(corpoValido({ linkDocId: LINK, recriar: true }), AUTORIZADO));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      code: 'SHOPEE_PUBLISH_BLOCKED',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.opcaoDeKitEmAnuncioComum,
      problemas: [{ campo: 'recriar' }],
    });
    expect(h.publicar).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
  });

  it('(M175 / M139) os 400 do corpo: --recriar sem linkDocId e as duas ações juntas — antes de qualquer leitura', async () => {
    semearKit();

    const semLink = await POST(req(corpoValido({ produtoId: KIT, recriar: true }), AUTORIZADO));
    expect(semLink.status).toBe(400);
    await expect(semLink.json()).resolves.toEqual({ error: MSG_RECRIAR_SEM_LINK });

    const juntas = await POST(
      req(
        corpoValido({ produtoId: KIT, linkDocId: 'x', recriar: true, converterEmKit: true }),
        AUTORIZADO,
      ),
    );
    expect(juntas.status).toBe(400);
    await expect(juntas.json()).resolves.toEqual({ error: MSG_OPCOES_DE_KIT_EXCLUSIVAS });
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.publicarKit).not.toHaveBeenCalled();
  });
});
