import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  shopeeCategoriaSchema,
  shopeeItemBaseInfoRowSchema,
  type ShopeeCategoria,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import { importacaoShopeeOptionsSchema, type ImportacaoShopeeOptions } from '@delfrance/schemas';

import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  aplicarCategoriasShopee,
  caminhoDaCategoriaDoAnuncio,
  criarMemoDeCategorias,
} from './categoriaShopee';
import type { ItemLido } from './itemLido';
import {
  idCategoriaShopee,
  planejarImportacaoShopee,
  type CategoriaParaCriar,
  type PreparoImportacaoShopee,
} from './planoImportacao';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;
const INTEGRACAO = 'int-1';
const AGORA = 1_757_000_000_000;

/** `Roupas > Camisetas > Manga Curta` — the leaf is 100017. */
const ARVORE: ShopeeCategoria[] = [
  { category_id: 100001, parent_category_id: 0, display_category_name: 'Roupas' },
  { category_id: 100009, parent_category_id: 100001, display_category_name: 'Camisetas' },
  { category_id: 100017, parent_category_id: 100009, display_category_name: 'Manga Curta' },
].map((c) => shopeeCategoriaSchema.parse({ has_children: false, ...c }));

function opcoes(parcial: Partial<ImportacaoShopeeOptions> = {}): ImportacaoShopeeOptions {
  return importacaoShopeeOptionsSchema.parse(parcial);
}

/** A client double that answers `get_category` and counts the calls. */
function clienteDeArvore(rows: readonly ShopeeCategoria[] = ARVORE) {
  const chamadas = { getCategory: 0 };
  const client = {
    getCategory: () => {
      chamadas.getCategory += 1;
      return Promise.resolve({ category_list: [...rows] });
    },
  } as unknown as ShopeeClient;
  return { client, chamadas };
}

function item(categoryId: number | null): ItemLido {
  return {
    base: shopeeItemBaseInfoRowSchema.parse({
      item_id: ITEM_ID,
      item_name: 'Camiseta Básica',
      category_id: categoryId,
    }),
    models: null,
    taxInfo: null,
    kit: null,
    itemId: ITEM_ID,
  };
}

function preparo(categorias: readonly ShopeeCategoria[]): PreparoImportacaoShopee {
  return {
    entrada: item(100017),
    integracaoId: INTEGRACAO,
    nowMs: AGORA,
    options: opcoes(),
    tabelaNormalOuterRef: null,
    tabelaPromocionalOuterRef: null,
    depositoOuterRef: null,
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
    categorias,
    imagensJaCacheadas: [],
  };
}

/** The real chain the plan produces for the leaf — never a hand-built fixture. */
function cadeiaPlanejada(categorias: readonly ShopeeCategoria[]): readonly CategoriaParaCriar[] {
  return planejarImportacaoShopee(preparo(categorias)).categorias;
}

beforeEach(() => {
  // The tree rides a process-wide TTL cache keyed by integração — a leftover
  // entry would serve one test's tree to the next.
  limparTaxonomiaShopee();
});

/* --------------------------------- the chain ------------------------------ */

describe('aplicarCategoriasShopee', () => {
  it('cria a cadeia inteira raiz→folha, com `categoriaPaiOuterRef` encadeado e a raiz em null', async () => {
    const db = new FakeDb();
    await aplicarCategoriasShopee(asDb(db), cadeiaPlanejada(ARVORE));

    expect(db.idsEm('categorias')).toEqual(['shopee-100001', 'shopee-100009', 'shopee-100017']);
    expect(db.store['categorias/shopee-100001']?.data.categoriaPaiOuterRef).toBeNull();
    expect(db.store['categorias/shopee-100009']?.data.categoriaPaiOuterRef).toBe(
      'documents/categorias/shopee-100001',
    );
    expect(db.store['categorias/shopee-100017']?.data.categoriaPaiOuterRef).toBe(
      'documents/categorias/shopee-100009',
    );
  });

  it('escreve a RAIZ primeiro — um filho nunca aponta para um documento que ainda não existe', async () => {
    const db = new FakeDb();
    await aplicarCategoriasShopee(asDb(db), cadeiaPlanejada(ARVORE));

    expect(db.writes.map((w) => w.path)).toEqual([
      'categorias/shopee-100001',
      'categorias/shopee-100009',
      'categorias/shopee-100017',
    ]);
  });

  it('`nomeCompleto` junta os NOMES com " > ", nunca os ids', async () => {
    const db = new FakeDb();
    await aplicarCategoriasShopee(asDb(db), cadeiaPlanejada(ARVORE));

    expect(db.store['categorias/shopee-100017']?.data.nomeCompleto).toBe(
      'Roupas > Camisetas > Manga Curta',
    );
    expect(db.store['categorias/shopee-100001']?.data.nomeCompleto).toBe('Roupas');
  });

  it('o id do documento carrega o PREFIXO — `categorias` é um espaço de nomes global', () => {
    expect(idCategoriaShopee(100017)).toBe('shopee-100017');
    expect(idCategoriaShopee(100017)).not.toBe('100017');
  });

  it('NUNCA sobrescreve uma categoria existente — nem a do operador, nem a do Flutter', async () => {
    const db = new FakeDb();
    db.seed('categorias/shopee-100009', { nome: 'Nome do operador', permiteCadastro: false });

    await aplicarCategoriasShopee(asDb(db), cadeiaPlanejada(ARVORE));

    expect(db.store['categorias/shopee-100009']?.data).toEqual({
      nome: 'Nome do operador',
      permiteCadastro: false,
    });
    // As outras duas foram criadas mesmo assim.
    expect(db.idsEm('categorias').sort()).toEqual([
      'shopee-100001',
      'shopee-100009',
      'shopee-100017',
    ]);
  });

  it('uma falha que NÃO é ALREADY_EXISTS propaga — não é um degrade', async () => {
    const db = new FakeDb();
    db.falhasDeCriacao.set(
      'categorias/shopee-100009',
      Object.assign(new Error('PERMISSION_DENIED'), { code: 7 }),
    );

    await expect(aplicarCategoriasShopee(asDb(db), cadeiaPlanejada(ARVORE))).rejects.toThrow(
      'PERMISSION_DENIED',
    );
  });
});

/* ------------------------------- the memo --------------------------------- */

describe('caminhoDaCategoriaDoAnuncio', () => {
  it('devolve a cadeia ROOT-FIRST e inclusiva, lida da árvore em cache', async () => {
    const { client } = clienteDeArvore();
    const memo = criarMemoDeCategorias(client, INTEGRACAO);

    const caminho = await caminhoDaCategoriaDoAnuncio(memo, 100017);
    expect(caminho.map((c) => c.category_id)).toEqual([100001, 100009, 100017]);
  });

  it('lê a árvore UMA vez por despacho, por mais itens que a consultem', async () => {
    const { client, chamadas } = clienteDeArvore();
    const memo = criarMemoDeCategorias(client, INTEGRACAO);

    await Promise.all([
      caminhoDaCategoriaDoAnuncio(memo, 100017),
      caminhoDaCategoriaDoAnuncio(memo, 100009),
    ]);
    await caminhoDaCategoriaDoAnuncio(memo, 100001);

    expect(chamadas.getCategory).toBe(1);
  });

  it('um `category_id` DESCONHECIDO não vincula nada e não falha', async () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client } = clienteDeArvore();
    const memo = criarMemoDeCategorias(client, INTEGRACAO);

    await expect(caminhoDaCategoriaDoAnuncio(memo, 999999)).resolves.toEqual([]);
    expect(avisos).toHaveBeenCalledTimes(1);
    avisos.mockRestore();
  });

  it('⛔ sem memo a perna de categoria é PULADA com um aviso — nunca uma falha, nunca uma chamada', async () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(caminhoDaCategoriaDoAnuncio(undefined, 100017)).resolves.toEqual([]);
    expect(avisos).toHaveBeenCalledTimes(1);
    avisos.mockRestore();
  });

  it('⛔ um `category_id` ausente ou ZERO não lê a árvore nem vincula nada', async () => {
    const { client, chamadas } = clienteDeArvore();
    const memo = criarMemoDeCategorias(client, INTEGRACAO);

    await expect(caminhoDaCategoriaDoAnuncio(memo, null)).resolves.toEqual([]);
    await expect(caminhoDaCategoriaDoAnuncio(memo, 0)).resolves.toEqual([]);
    expect(chamadas.getCategory).toBe(0);
  });

  it('uma cadeia VAZIA não planeja nem escreve categoria nenhuma', async () => {
    const db = new FakeDb();
    await aplicarCategoriasShopee(asDb(db), cadeiaPlanejada([]));
    expect(db.writes).toEqual([]);
  });
});

/* ------------------------ the memo's FAILURE path ------------------------- */

/** A double whose first `n` reads reject and whose next one answers the tree. */
function clienteInstavel(falhas: number) {
  const chamadas = { getCategory: 0 };
  const client = {
    getCategory: () => {
      chamadas.getCategory += 1;
      if (chamadas.getCategory <= falhas) {
        return Promise.reject(new TypeError('get_category: fetch failed'));
      }
      return Promise.resolve({ category_list: [...ARVORE] });
    },
  } as unknown as ShopeeClient;
  return { client, chamadas };
}

/** A double whose read stays IN FLIGHT until the test settles it by hand. */
function clienteAdiado() {
  const chamadas = { getCategory: 0 };
  let liberar: ((rows: readonly ShopeeCategoria[]) => void) | null = null;
  let recusar: ((err: unknown) => void) | null = null;
  const client = {
    getCategory: () =>
      new Promise((resolve, reject) => {
        chamadas.getCategory += 1;
        liberar = (rows) => resolve({ category_list: [...rows] });
        recusar = reject;
      }),
  } as unknown as ShopeeClient;
  return {
    client,
    chamadas,
    responder: (rows: readonly ShopeeCategoria[] = ARVORE) => liberar?.(rows),
    falhar: (err: unknown) => recusar?.(err),
  };
}

describe('criarMemoDeCategorias', () => {
  it('uma leitura que FALHA não envenena o despacho — o próximo item lê de novo e importa', async () => {
    const { client, chamadas } = clienteInstavel(1);
    const memo = criarMemoDeCategorias(client, INTEGRACAO);

    await expect(memo.carregar()).rejects.toThrow('fetch failed');

    const indice = await memo.carregar();
    expect(indice.porId.get(100017)?.display_category_name).toBe('Manga Curta');
    expect(chamadas.getCategory).toBe(2);
  });

  it('⛔ duas chamadas EM VOO compartilham UMA leitura — o single-flight continua de pé', async () => {
    const { client, chamadas, responder } = clienteAdiado();
    const memo = criarMemoDeCategorias(client, INTEGRACAO);

    const primeira = memo.carregar();
    const segunda = memo.carregar();
    expect(chamadas.getCategory).toBe(1);

    responder();
    const [a, b] = await Promise.all([primeira, segunda]);
    expect(a).toBe(b);
    expect(chamadas.getCategory).toBe(1);
  });

  it('⛔ quando a leitura COMPARTILHADA falha, os dois que esperavam veem a MESMA rejeição', async () => {
    const { client, chamadas, falhar } = clienteAdiado();
    const memo = criarMemoDeCategorias(client, INTEGRACAO);

    const falha = new TypeError('get_category: fetch failed');
    const primeira = memo.carregar();
    const segunda = memo.carregar();
    const desfechos = Promise.allSettled([primeira, segunda]);
    falhar(falha);

    const [a, b] = await desfechos;
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(a.status === 'rejected' ? a.reason : null).toBe(falha);
    expect(b.status === 'rejected' ? b.reason : null).toBe(falha);
    expect(chamadas.getCategory).toBe(1);
  });

  it('depois de uma leitura BEM-SUCEDIDA nada é lido de novo — o memo continua sendo memo', async () => {
    const { client, chamadas } = clienteInstavel(0);
    const memo = criarMemoDeCategorias(client, INTEGRACAO);

    const primeira = await memo.carregar();
    const segunda = await memo.carregar();

    expect(segunda).toBe(primeira);
    expect(chamadas.getCategory).toBe(1);
  });
});
