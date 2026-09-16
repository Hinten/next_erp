import { describe, expect, it } from 'vitest';

import {
  shopeeItemBaseInfoRowSchema,
  shopeeModelListPayloadSchema,
  type ShopeeModel,
} from '@delfrance/integrations-shopee';
import {
  importacaoShopeeOptionsSchema,
  makeEstoqueUid,
  type ImportacaoShopeeOptions,
} from '@delfrance/schemas';
import { produtoCollection } from '@delfrance/data/admin/collections';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  ShopeePrecoDesatualizadoError,
  aplicarEstoqueShopee,
  aplicarPrecosShopee,
  lerLinhaDeEstoque,
} from './estoquePrecos';
import type { ItemLido } from './itemLido';
import {
  planejarImportacaoShopee,
  type PlanoImportacaoShopee,
  type PreparoImportacaoShopee,
} from './planoImportacao';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;
const MODEL_ID = 2000458802;
const INTEGRACAO = 'int-1';
const TABELA_NORMAL = 'documents/listaDePrecos/tab-normal';
const TABELA_PROMOCIONAL = 'documents/listaDePrecos/tab-promo';
/** ⚠️ `produto.precos` é chaveado pelo ID do documento da lista, nunca pelo ref. */
const TABELA_NORMAL_ID = 'tab-normal';
const DEPOSITO = 'documents/depositos/dep-1';
const PRODUTO = 'prod-1';
const AGORA = 1_757_000_000_000;

const PRECO_BRL = [{ currency: 'BRL', original_price: 99.9, current_price: 49.9 }];
const ESTOQUE_10 = { seller_stock: [{ location_id: 'BR', stock: 10, if_saleable: true }] };

function opcoes(parcial: Partial<ImportacaoShopeeOptions> = {}): ImportacaoShopeeOptions {
  return importacaoShopeeOptionsSchema.parse(parcial);
}

function item(parcial: Record<string, unknown> = {}, models?: ItemLido['models']): ItemLido {
  return {
    base: shopeeItemBaseInfoRowSchema.parse({
      item_id: ITEM_ID,
      item_name: 'Camiseta Básica',
      ...parcial,
    }),
    models: models ?? null,
    taxInfo: null,
    kit: null,
    itemId: ITEM_ID,
  };
}

function modelos(models: Record<string, unknown>[]) {
  return shopeeModelListPayloadSchema.parse({
    model: models,
    tier_variation: [{ name: 'Cor', option_list: [{ option: 'Azul' }] }],
  });
}

function preparo(parcial: Partial<PreparoImportacaoShopee> = {}): PreparoImportacaoShopee {
  return {
    entrada: item({ price_info: PRECO_BRL, stock_info_v2: ESTOQUE_10 }),
    integracaoId: INTEGRACAO,
    nowMs: AGORA,
    options: opcoes(),
    tabelaNormalOuterRef: TABELA_NORMAL,
    tabelaPromocionalOuterRef: TABELA_PROMOCIONAL,
    depositoOuterRef: DEPOSITO,
    pai: {
      existente: null,
      extraData: null,
      linkSobFilho: false,
      jaTemFilhos: false,
      estoque: null,
    },
    filhos: [],
    linkPai: null,
    grupos: { docs: [] },
    categorias: [],
    imagensJaCacheadas: [],
    ...parcial,
  };
}

function plano(parcial: Partial<PreparoImportacaoShopee> = {}): PlanoImportacaoShopee {
  return planejarImportacaoShopee(preparo(parcial));
}

/** An existing produto, as the ERP holds it before a re-import. */
function semearProduto(db: FakeDb, precos: Record<string, unknown> | null = null): void {
  db.seed(`produtos/${PRODUTO}`, {
    nome: 'Camiseta Básica',
    paiId: null,
    precos,
  });
}

const EXISTENTE = { id: PRODUTO, raw: { nome: 'Camiseta Básica', paiId: null } };

/* ------------------------------ 1. os preços ------------------------------ */

describe('os preços — de onde vêm e para onde vão', () => {
  it('usa a primeira entrada em BRL e manda `original_price` para a tabela NORMAL', () => {
    const p = plano({ pai: { ...preparo().pai, existente: EXISTENTE } });
    expect(p.precosPai?.patch).toEqual({ [`precos.${TABELA_NORMAL_ID}`]: { valor: 99.9 } });
  });

  it('⛔ NEAR-MISS: um anúncio só em SGD não planeja preço NENHUM', () => {
    const p = plano({
      entrada: item({
        price_info: [{ currency: 'SGD', original_price: 99.9, current_price: 49.9 }],
        stock_info_v2: ESTOQUE_10,
      }),
      pai: { ...preparo().pai, existente: EXISTENTE },
    });
    expect(p.precosPai).toBeNull();
    expect(p.precoPaiIgnorado).toBe('moeda-nao-brl');
  });

  it('⛔ `tabelaPromocionalOuterRef` NÃO aparece em escrita nenhuma do import', async () => {
    const db = new FakeDb();
    semearProduto(db);
    const p = plano({ pai: { ...preparo().pai, existente: EXISTENTE } });

    const snap = await produtoCollection.docRef(asDb(db), {}, PRODUTO).get();
    await aplicarPrecosShopee(asDb(db), p.precosPai, snap.updateTime);

    const escrito = JSON.stringify(db.writes);
    expect(escrito).toContain(TABELA_NORMAL_ID);
    expect(escrito).not.toContain(TABELA_PROMOCIONAL);
  });

  it('na CRIAÇÃO o preço já vai dentro do documento — não há patch guardado', () => {
    const p = plano();
    expect(p.criar).toBe(true);
    expect(p.precosPai).toBeNull();
    expect(p.produtoPai?.data.precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 99.9 } });
  });

  it('na ATUALIZAÇÃO o patch é um caminho PONTILHADO — a tabela vizinha não é tocada', async () => {
    const db = new FakeDb();
    semearProduto(db, { outra: { valor: 5 } });
    const p = plano({ pai: { ...preparo().pai, existente: EXISTENTE } });

    const snap = await produtoCollection.docRef(asDb(db), {}, PRODUTO).get();
    await aplicarPrecosShopee(asDb(db), p.precosPai, snap.updateTime);

    expect(db.store[`produtos/${PRODUTO}`]?.data.precos).toEqual({
      outra: { valor: 5 },
      [TABELA_NORMAL_ID]: { valor: 99.9 },
    });
    expect(db.patches[0]?.patch).toEqual({ [`precos.${TABELA_NORMAL_ID}`]: { valor: 99.9 } });
  });

  it('um valor abaixo de 0,01 é DESCARTADO — o schema o recusaria no parse', () => {
    const p = plano({
      entrada: item({
        price_info: [{ currency: 'BRL', original_price: 0, current_price: 0 }],
        stock_info_v2: ESTOQUE_10,
      }),
      pai: { ...preparo().pai, existente: EXISTENTE },
    });
    expect(p.precosPai).toBeNull();
    expect(p.precoPaiIgnorado).toBe('valor-abaixo-do-minimo');
  });

  it('um anúncio COM models não escreve preço no pai — a wire nem manda `price_info` nele', () => {
    const p = plano({
      entrada: item({ has_model: true }, modelos([{ model_id: MODEL_ID, price_info: PRECO_BRL }])),
      filhos: [
        {
          modelo: { model_id: MODEL_ID, price_info: PRECO_BRL } as unknown as ShopeeModel,
          existente: null,
          vinculoDeOutraFamilia: false,
          link: null,
          estoque: null,
        },
      ],
      pai: { ...preparo().pai, existente: EXISTENTE },
    });
    expect(p.precosPai).toBeNull();
    expect(p.precoPaiIgnorado).toBe('pai-com-filhos');
  });
});

/* -------------------- 2. a ORDEM guardada (M11) --------------------------- */

describe('a escrita guardada de preços', () => {
  it('⛔ M11: o merge do produto ANTES do patch invalida a pré-condição e o patch FALHA', async () => {
    const db = new FakeDb();
    semearProduto(db);
    const p = plano({ pai: { ...preparo().pai, existente: EXISTENTE } });

    // A ordem ERRADA: lê, mescla o produto (o que BUMPA o updateTime) e só
    // então tenta o patch guardado com o carimbo que acabou de invalidar.
    const snap = await produtoCollection.docRef(asDb(db), {}, PRODUTO).get();
    await produtoCollection.merge(asDb(db), {}, PRODUTO, { ultimaModificacao: AGORA });

    await expect(aplicarPrecosShopee(asDb(db), p.precosPai, snap.updateTime)).rejects.toThrow(
      ShopeePrecoDesatualizadoError,
    );
    expect(db.store[`produtos/${PRODUTO}`]?.data.precos).toBeNull();
  });

  it('na ordem CERTA — patch, depois merge — os dois pousam', async () => {
    const db = new FakeDb();
    semearProduto(db);
    const p = plano({ pai: { ...preparo().pai, existente: EXISTENTE } });

    const snap = await produtoCollection.docRef(asDb(db), {}, PRODUTO).get();
    await aplicarPrecosShopee(asDb(db), p.precosPai, snap.updateTime);
    await produtoCollection.merge(asDb(db), {}, PRODUTO, { ultimaModificacao: AGORA });

    expect(db.store[`produtos/${PRODUTO}`]?.data.precos).toEqual({
      [TABELA_NORMAL_ID]: { valor: 99.9 },
    });
  });

  it('⛔ um carimbo que não é carimbo NENHUM não vira uma escrita sem guarda', async () => {
    const db = new FakeDb();
    semearProduto(db);
    const p = plano({ pai: { ...preparo().pai, existente: EXISTENTE } });

    await expect(aplicarPrecosShopee(asDb(db), p.precosPai, 42)).rejects.toThrow(
      ShopeePrecoDesatualizadoError,
    );
  });

  it('sem patch nenhum não escreve nada', async () => {
    const db = new FakeDb();
    semearProduto(db);
    await aplicarPrecosShopee(asDb(db), null, undefined);
    expect(db.writes).toEqual([]);
  });
});

/* -------------------------------- 3. o estoque ---------------------------- */

describe('o estoque', () => {
  it('soma `seller_stock` e SOMA DE VOLTA a reserva — nunca `shopee_stock`', () => {
    const p = plano({
      entrada: item({
        price_info: PRECO_BRL,
        stock_info_v2: {
          seller_stock: [
            { location_id: 'BR-A', stock: 4 },
            { location_id: 'BR-B', stock: 6 },
          ],
          shopee_stock: [{ location_id: 'FBS', stock: 100 }],
        },
      }),
      options: opcoes({ sobrescreverEstoque: true }),
      pai: {
        ...preparo().pai,
        existente: EXISTENTE,
        estoque: { docId: 'legado-1', quantidade: 0, quantidadeReservada: 3 },
      },
    });
    expect(p.estoquePai?.data.quantidade).toBe(13);
  });

  it('⛔ uma reserva NEGATIVA armazenada não encolhe a contagem — o piso é `reservaEfetiva`', () => {
    const p = plano({
      options: opcoes({ sobrescreverEstoque: true }),
      pai: {
        ...preparo().pai,
        existente: EXISTENTE,
        estoque: { docId: 'legado-1', quantidade: 0, quantidadeReservada: -5 },
      },
    });
    expect(p.estoquePai?.data.quantidade).toBe(10);
  });

  it('escreve na LINHA QUE LEU — um id automático do legado, nunca o id canônico', async () => {
    const db = new FakeDb();
    const p = plano({
      options: opcoes({ sobrescreverEstoque: true }),
      pai: {
        ...preparo().pai,
        existente: EXISTENTE,
        estoque: { docId: 'legado-auto-9', quantidade: 2, quantidadeReservada: 0 },
      },
    });

    await aplicarEstoqueShopee(asDb(db), p.estoquePai);

    expect(db.idsEm(`produtos/${PRODUTO}/estoques`)).toEqual(['legado-auto-9']);
    expect(db.idsEm(`produtos/${PRODUTO}/estoques`)).not.toContain(
      makeEstoqueUid(PRODUTO, 'dep-1'),
    );
  });

  it('sem linha alguma CRIA no id canônico', async () => {
    const db = new FakeDb();
    const p = plano();
    await aplicarEstoqueShopee(asDb(db), p.estoquePai);

    const produtoId = p.produtoId;
    expect(db.idsEm(`produtos/${produtoId}/estoques`)).toEqual([
      makeEstoqueUid(produtoId, 'dep-1'),
    ]);
    expect(
      db.store[`produtos/${produtoId}/estoques/${makeEstoqueUid(produtoId, 'dep-1')}`]?.data,
    ).toMatchObject({ quantidade: 10, dataCriacao: AGORA, parentId: produtoId });
  });

  it('a sobrescrita é um MERGE de quantidade — nunca recarimba a reserva, que é do picking', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${PRODUTO}/estoques/legado-1`, {
      parentId: PRODUTO,
      depositoOuterRef: DEPOSITO,
      quantidade: 2,
      quantidadeReservada: 3,
    });
    const p = plano({
      options: opcoes({ sobrescreverEstoque: true }),
      pai: {
        ...preparo().pai,
        existente: EXISTENTE,
        estoque: { docId: 'legado-1', quantidade: 2, quantidadeReservada: 3 },
      },
    });

    await aplicarEstoqueShopee(asDb(db), p.estoquePai);

    expect(db.store[`produtos/${PRODUTO}/estoques/legado-1`]?.data).toMatchObject({
      quantidade: 13,
      quantidadeReservada: 3,
      ultimaModificacao: AGORA,
    });
    expect(db.writes[0]?.patch).toEqual({ quantidade: 13, ultimaModificacao: AGORA });
  });

  it('as DUAS opções são assimétricas: cria por padrão, sobrescreve só quando mandam', () => {
    const existente = {
      ...preparo().pai,
      existente: EXISTENTE,
      estoque: { docId: 'legado-1', quantidade: 2, quantidadeReservada: 0 },
    };
    expect(plano({ pai: existente }).estoquePai).toBeNull();
    expect(plano({ pai: existente }).estoquePaiIgnorado).toBe('sem-sobrescrever');

    expect(plano().estoquePai).not.toBeNull();
    expect(plano({ options: opcoes({ importarEstoque: false }) }).estoquePai).toBeNull();
  });

  it('⛔ NUNCA escreve estoque num pai que JÁ TEM FILHOS no ERP, mesmo sem models na carga', () => {
    const p = plano({
      pai: { ...preparo().pai, existente: EXISTENTE, jaTemFilhos: true },
    });
    expect(p.estoquePai).toBeNull();
    expect(p.estoquePaiIgnorado).toBe('pai-com-filhos');
  });

  it('sem `depositoOuterRef` a perna de estoque é pulada, nunca uma exceção', () => {
    const p = plano({ depositoOuterRef: null });
    expect(p.estoquePai).toBeNull();
    expect(p.estoquePaiIgnorado).toBe('sem-deposito');
  });
});

/* --------------------------- 4. a linha que foi lida ---------------------- */

describe('lerLinhaDeEstoque', () => {
  it('casa o depósito pelo ÚLTIMO segmento do ref — `documents/` ou a forma nua', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${PRODUTO}/estoques/legado-1`, {
      depositoOuterRef: 'depositos/dep-1',
      quantidade: 7,
      quantidadeReservada: 2,
    });

    await expect(lerLinhaDeEstoque(asDb(db), PRODUTO, DEPOSITO)).resolves.toEqual({
      docId: 'legado-1',
      quantidade: 7,
      quantidadeReservada: 2,
    });
  });

  it('⛔ a linha de OUTRO depósito não é a desta conta', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${PRODUTO}/estoques/outro`, {
      depositoOuterRef: 'documents/depositos/dep-2',
      quantidade: 7,
    });

    await expect(lerLinhaDeEstoque(asDb(db), PRODUTO, DEPOSITO)).resolves.toBeNull();
  });

  it('sem depósito configurado não lê nada — zero consultas', async () => {
    const db = new FakeDb();
    await expect(lerLinhaDeEstoque(asDb(db), PRODUTO, null)).resolves.toBeNull();
    expect(db.consultas).toEqual([]);
  });

  it('a reserva chega CRUA — o piso é do cálculo, não do repouso', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${PRODUTO}/estoques/legado-1`, {
      depositoOuterRef: DEPOSITO,
      quantidade: 7,
      quantidadeReservada: -5,
    });

    const linha = await lerLinhaDeEstoque(asDb(db), PRODUTO, DEPOSITO);
    expect(linha?.quantidadeReservada).toBe(-5);
  });
});
