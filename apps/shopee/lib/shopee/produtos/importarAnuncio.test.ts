import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  shopeeCategoriaSchema,
  shopeeItemBaseInfoRowSchema,
  shopeeModelListPayloadSchema,
  type ShopeeCategoria,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import {
  importacaoShopeeOptionsSchema,
  productArquivoId,
  type ImportacaoShopeeOptions,
} from '@delfrance/schemas';

import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { FakeBucket, asBucket } from '../testing/fakeBucket';
import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import { criarMemoDeCategorias } from './categoriaShopee';
import { ShopeeImportBlockedError } from './errosImportacao';
import {
  aplicarImportacaoShopee,
  importarAnuncioShopee,
  prepararImportacaoShopee,
} from './importarAnuncio';
import type { ImportarAnuncioDeps, ItemLido } from './itemLido';
import { idDoFilhoPlanejado, idDoPaiPlanejado } from './resolveProduto';
import { criarMemoDeGrupos } from './taxonomiaShopee';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;
const OUTRO_ITEM_ID = 2500139862;
const MODEL_A = 2000458802;
const MODEL_B = 2000458803;
const INTEGRACAO = 'int-1';
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;
const TABELA_NORMAL = 'documents/listaDePrecos/tab-normal';
const TABELA_NORMAL_ID = 'tab-normal';
const DEPOSITO = 'documents/depositos/dep-1';
const PAI_EXISTENTE = 'pai-existente';
const AGORA = 1_757_000_000_000;

const PRECO_BRL = [{ currency: 'BRL', original_price: 99.9, current_price: 49.9 }];
const ESTOQUE_7 = { seller_stock: [{ location_id: 'BR', stock: 7, if_saleable: true }] };

/** `Roupas > Camisetas > Manga Curta` — a leaf of 100017, three documents deep. */
const ARVORE: ShopeeCategoria[] = [
  { category_id: 100001, parent_category_id: 0, display_category_name: 'Roupas' },
  { category_id: 100009, parent_category_id: 100001, display_category_name: 'Camisetas' },
  { category_id: 100017, parent_category_id: 100009, display_category_name: 'Manga Curta' },
].map((c) => shopeeCategoriaSchema.parse({ has_children: false, ...c }));

const TIER_COR = [
  {
    name: 'Cor',
    option_list: [
      { option: 'Azul', image: null },
      { option: 'Verde', image: null },
    ],
  },
];

const TIERS_COR_TAMANHO = [
  ...TIER_COR,
  { name: 'Tamanho', option_list: [{ option: 'M', image: null }] },
];

const URL_FOTO = 'https://cf.shopee.com.br/file/foto-1';
const BYTES_FOTO = Buffer.from('bytes de uma imagem que ninguém decodifica');
const HASH_FOTO = createHash('sha512').update(BYTES_FOTO).digest('hex');

function opcoes(parcial: Partial<ImportacaoShopeeOptions> = {}): ImportacaoShopeeOptions {
  return importacaoShopeeOptionsSchema.parse(parcial);
}

function item(parcial: Record<string, unknown> = {}, models: ItemLido['models'] = null): ItemLido {
  const base = shopeeItemBaseInfoRowSchema.parse({
    item_id: ITEM_ID,
    item_name: 'Camiseta Básica',
    item_sku: 'CAM-001',
    category_id: 100017,
    weight: '0.5',
    ...parcial,
  });
  return { base, models, taxInfo: null, kit: null, itemId: base.item_id };
}

function modelos(ms: Record<string, unknown>[], tiers: unknown = TIERS_COR_TAMANHO) {
  return shopeeModelListPayloadSchema.parse({ model: ms, tier_variation: tiers });
}

/** The simple, no-model listing every ordering test starts from. */
function anuncioSimples(parcial: Record<string, unknown> = {}): ItemLido {
  return item({ price_info: PRECO_BRL, stock_info_v2: ESTOQUE_7, ...parcial });
}

/**
 * A listing with models and NO tier tree — `has_model` is true, so the memo is
 * loaded, while nothing is planned for `grupoDeVariacoes`. That is what lets a
 * memo-sharing test observe the READ without a create race in the way.
 */
function anuncioComModelosSemTiers(itemId: number, sku: string, modelId: number): ItemLido {
  return item(
    { item_id: itemId, item_sku: sku, has_model: true },
    modelos([{ model_id: modelId, model_sku: `${sku}-A`, price_info: PRECO_BRL }], []),
  );
}

/** Two models over two tiers — `Azul M` and `Verde M`. */
function anuncioDeDoisTiers(): ItemLido {
  return item(
    // ⚠️ O anúncio pai CARREGA estoque no payload — é o que torna visível a
    // regra de que um pai com filhos nunca recebe uma linha de estoque.
    { has_model: true, description: 'Uma camiseta.', stock_info_v2: ESTOQUE_7 },
    modelos([
      {
        model_id: MODEL_A,
        tier_index: [0, 0],
        model_sku: 'CAM-001-AZ',
        price_info: PRECO_BRL,
        stock_info_v2: ESTOQUE_7,
      },
      {
        model_id: MODEL_B,
        tier_index: [1, 0],
        model_sku: 'CAM-001-VD',
        price_info: PRECO_BRL,
        stock_info_v2: ESTOQUE_7,
      },
    ]),
  );
}

/**
 * A Shopee client that answers `get_category` and **throws on every other
 * property**, so the claim «o importador não emite nenhuma chamada de
 * `item_base_info`» is structural rather than asserted by counting.
 *
 * ⚠️ It records the property ACCESS, not the call: reaching for a method is
 * already the defect, whether or not the test awaits it.
 */
interface ClienteDeTeste {
  readonly client: ShopeeClient;
  readonly chamadas: string[];
}

function clienteQueRecusa(rows: readonly ShopeeCategoria[] = ARVORE): ClienteDeTeste {
  const chamadas: string[] = [];
  const client = new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      if (typeof prop !== 'string') return undefined;
      chamadas.push(prop);
      if (prop === 'getCategory') return () => Promise.resolve({ category_list: [...rows] });
      return () => {
        throw new Error(`o importador chamou a Shopee: ${prop}`);
      };
    },
  }) as unknown as ShopeeClient;
  return { client, chamadas };
}

let cliente = clienteQueRecusa();

beforeEach(() => {
  limparTaxonomiaShopee();
  cliente = clienteQueRecusa();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

function deps(db: FakeDb, parcial: Partial<ImportarAnuncioDeps> = {}): ImportarAnuncioDeps {
  return {
    db: asDb(db),
    integracaoId: INTEGRACAO,
    tabelaNormalOuterRef: TABELA_NORMAL,
    tabelaPromocionalOuterRef: null,
    depositoOuterRef: DEPOSITO,
    options: opcoes({ importarFotos: false }),
    nowMs: AGORA,
    categorias: criarMemoDeCategorias(cliente.client, INTEGRACAO),
    ...parcial,
  };
}

/** A fetch double that serves {@link BYTES_FOTO} as a PNG. */
function fetchDeFoto(): typeof globalThis.fetch {
  return (() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: () => Promise.resolve(Uint8Array.from(BYTES_FOTO).buffer),
    })) as unknown as typeof globalThis.fetch;
}

/**
 * Every write this import made, as an ORDERED list of step labels.
 *
 * The parent produto is written by up to four different steps, so the label is
 * decided by the patch's KEYS — a path alone could not tell the guarded price
 * patch from the merge that follows it, which is the one ordering M11 is about.
 */
function passos(db: FakeDb, paiId: string, filhos: readonly string[] = []): string[] {
  return db.writes.map((w) => {
    const chaves = Object.keys(w.patch);
    if (w.path.startsWith('grupoDeVariacoes/')) return 'taxonomia';
    if (w.path.startsWith('categorias/')) return 'categoria';
    if (w.path.startsWith('arquivos/')) return 'arquivo';
    if (w.path === `produtos/${paiId}`) {
      if (chaves.some((k) => k.startsWith('precos.'))) return 'preco-pai';
      // ⚠️ `fotos` SOZINHO não distingue nada: o documento de criação também
      // carrega a chave. O append de fotos é o patch de exatamente duas.
      if (chaves.length === 2 && chaves.includes('fotos') && chaves.includes('fotosArquivosIds')) {
        return 'fotos-pai';
      }
      // Mesma armadilha: o documento de criação carrega `filhoUnicoId`. O
      // reparo do ponteiro é o patch de exatamente estas duas chaves.
      if (
        chaves.length === 2 &&
        chaves.includes('filhoUnicoId') &&
        chaves.includes('ultimaModificacao')
      ) {
        return 'filho-unico';
      }
      return 'produto-pai';
    }
    if (w.path.startsWith(`produtos/${paiId}/extraData/`)) return 'extraData';
    if (w.path.startsWith(`produtos/${paiId}/estoques/`)) return 'estoque-pai';
    if (w.path.startsWith(`produtos/${paiId}/prodshopee/`)) return 'link-pai';
    for (const [i, id] of filhos.entries()) {
      if (w.path === `produtos/${id}`) {
        return chaves.some((k) => k.startsWith('precos.'))
          ? `preco-filho${i}`
          : `produto-filho${i}`;
      }
      if (w.path.startsWith(`produtos/${id}/estoques/`)) return `estoque-filho${i}`;
      if (w.path.startsWith(`produtos/${id}/variashopee/`)) return `link-filho${i}`;
    }
    return `?? ${w.path}`;
  });
}

/** Seed a parent produto plus the `prodshopee` that makes rung 1 resolve it. */
function semearPaiComVinculo(db: FakeDb, extra: Record<string, unknown> = {}): void {
  db.seed(`produtos/${PAI_EXISTENTE}`, {
    nome: 'Camiseta Básica',
    sku: 'CAM-001',
    paiId: null,
    ...extra,
  });
  db.seed(`produtos/${PAI_EXISTENTE}/prodshopee/link-1`, {
    item_id: ITEM_ID,
    contaProdutoShopeeOuterRef: REF_CONTA,
  });
}

/** A stored grupo carrying a key only the Flutter app authors. */
function semearGrupoCor(db: FakeDb): void {
  db.seed('grupoDeVariacoes/g-cor', {
    nome: 'Cor',
    codigo: null,
    ordem: 7,
    tipo: 2,
    permiteFotos: true,
    variacoes: [{ id: 'v-azul', nome: 'Azul', codigo: null }],
    variacoesIds: ['v-azul'],
    campoSoDoFlutter: 'não modelado aqui',
  });
}

function consultasDeGrupo(db: FakeDb): unknown[] {
  return db.consultas.filter((c) => c.fonte === 'grupoDeVariacoes');
}

/**
 * The same FakeDb, with every WRITE verb replaced by a throw.
 *
 * ⚠️ This is the whole proof that `prepararImportacaoShopee` is write-free:
 * the property is structural (it must hold for every branch of the call
 * graph), and a `db.writes` assertion could only ever show that the branches
 * this test happened to take wrote nothing.
 */
const VERBOS_DE_ESCRITA = ['create', 'set', 'update', 'delete', 'add'];

function semEscrita<T>(alvo: T): T {
  if (typeof alvo !== 'object' || alvo === null) return alvo;
  return new Proxy(alvo as unknown as object, {
    get(t, prop) {
      if (typeof prop === 'string' && VERBOS_DE_ESCRITA.includes(prop)) {
        return () => {
          throw new Error(`escrita proibida na metade que só lê: ${prop}`);
        };
      }
      const valor: unknown = Reflect.get(t, prop);
      if (typeof valor === 'function') {
        return (...args: unknown[]) =>
          semEscrita((valor as (...a: unknown[]) => unknown).apply(t, args));
      }
      return valor;
    },
  }) as unknown as T;
}

/* ------------------------- 1. a ORDEM das escritas ------------------------ */

describe('aplicarImportacaoShopee — a ordem de escrita', () => {
  it('um anúncio SIMPLES escreve na ordem do docblock, com as fotos POR ÚLTIMO', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    const paiId = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);

    await importarAnuncioShopee(
      deps(db, {
        options: opcoes(),
        bucket: asBucket(bucket),
        fetchImpl: fetchDeFoto(),
      }),
      anuncioSimples({ image: { image_url_list: [URL_FOTO], image_id_list: ['img-1'] } }),
    );

    // Uma SEQUÊNCIA, não um conjunto.
    expect(passos(db, paiId)).toEqual([
      'categoria',
      'categoria',
      'categoria',
      'produto-pai',
      'extraData',
      'estoque-pai',
      'link-pai',
      'arquivo',
      'arquivo',
      'fotos-pai',
    ]);
    expect(bucket.caminhos).toHaveLength(1);
  });

  it('um anúncio de DOIS tiers escreve taxonomia → categorias → pai → vínculo → filhos', async () => {
    const db = new FakeDb();
    semearPaiComVinculo(db);
    const filhos = [MODEL_A, MODEL_B].map((m) => idDoFilhoPlanejado(PAI_EXISTENTE, m));

    await importarAnuncioShopee(deps(db), anuncioDeDoisTiers());

    expect(passos(db, PAI_EXISTENTE, filhos)).toEqual([
      'taxonomia',
      'taxonomia',
      'categoria',
      'categoria',
      'categoria',
      'produto-pai',
      'extraData',
      'link-pai',
      'produto-filho0',
      'estoque-filho0',
      'link-filho0',
      'produto-filho1',
      'estoque-filho1',
      'link-filho1',
    ]);
  });

  it('⛔ o patch de preço GUARDADO vai antes do merge do produto — trocar a ordem quebra a precondição', async () => {
    const db = new FakeDb();
    semearPaiComVinculo(db);

    await importarAnuncioShopee(deps(db), anuncioSimples());

    expect(passos(db, PAI_EXISTENTE)).toEqual([
      'categoria',
      'categoria',
      'categoria',
      'preco-pai',
      'produto-pai',
      'estoque-pai',
      'link-pai',
    ]);
    // O patch nomeia UMA chave pontilhada: a tabela da conta, e nada mais.
    expect(Object.keys(db.patches[0]?.patch ?? {})).toEqual([`precos.${TABELA_NORMAL_ID}`]);
    expect(db.store[`produtos/${PAI_EXISTENTE}`]?.data.precos).toEqual({
      [TABELA_NORMAL_ID]: { valor: 99.9 },
    });
  });

  it('o filho repete a ordem do pai um nível abaixo, e `filhoUnicoId` vem DEPOIS do último filho', async () => {
    const db = new FakeDb();
    semearPaiComVinculo(db);
    db.seed('produtos/filho-existente', {
      nome: 'Camiseta Básica Azul',
      sku: 'CAM-001-AZ',
      paiId: PAI_EXISTENTE,
    });

    await importarAnuncioShopee(
      deps(db),
      item(
        { has_model: true },
        modelos(
          [
            {
              model_id: MODEL_A,
              tier_index: [0],
              model_sku: 'CAM-001-AZ',
              price_info: PRECO_BRL,
              stock_info_v2: ESTOQUE_7,
            },
          ],
          TIER_COR,
        ),
      ),
    );

    expect(passos(db, PAI_EXISTENTE, ['filho-existente'])).toEqual([
      'taxonomia',
      'categoria',
      'categoria',
      'categoria',
      'produto-pai',
      'link-pai',
      'preco-filho0',
      'produto-filho0',
      'estoque-filho0',
      'link-filho0',
      'filho-unico',
    ]);
    expect(db.store[`produtos/${PAI_EXISTENTE}`]?.data.filhoUnicoId).toBe('filho-existente');
  });
});

/* ---------------------- 2. a metade que SÓ LÊ ----------------------------- */

describe('prepararImportacaoShopee — estruturalmente livre de escrita', () => {
  it('planeja um anúncio inteiro sobre um banco que LANÇA em todo verbo de escrita', async () => {
    const db = new FakeDb();
    semearPaiComVinculo(db);

    const plano = await prepararImportacaoShopee(
      { ...deps(db), db: semEscrita(asDb(db)) },
      anuncioDeDoisTiers(),
    );

    expect(plano.produtoId).toBe(PAI_EXISTENTE);
    expect(plano.filhos).toHaveLength(2);
    expect(db.writes).toEqual([]);
  });

  it('⛔ o mesmo banco guardado RECUSA o aplicador — a prova acima não é vácua', async () => {
    const db = new FakeDb();
    semearPaiComVinculo(db);
    const entrada = anuncioSimples();
    const plano = await prepararImportacaoShopee(deps(db), entrada);

    await expect(
      aplicarImportacaoShopee({ ...deps(db), db: semEscrita(asDb(db)) }, plano),
    ).rejects.toThrow('escrita proibida');
  });
});

/* ----------------------------- 3. as recusas ------------------------------ */

describe('importarAnuncioShopee — cada recusa vem antes da primeira escrita', () => {
  it('`sem-nome`', async () => {
    const db = new FakeDb();
    await expect(importarAnuncioShopee(deps(db), item({ item_name: '   ' }))).rejects.toMatchObject(
      { motivo: 'sem-nome', itemId: ITEM_ID },
    );
    expect(db.writes).toEqual([]);
  });

  it('`item-deletado`', async () => {
    const db = new FakeDb();
    await expect(
      importarAnuncioShopee(deps(db), anuncioSimples({ item_status: 'SELLER_DELETE' })),
    ).rejects.toMatchObject({ motivo: 'item-deletado' });
    expect(db.writes).toEqual([]);
  });

  it('`vinculo-inconsistente` — um `prodshopee` que mora sob um produto FILHO', async () => {
    const db = new FakeDb();
    db.seed('produtos/filho-x', { nome: 'Filho', paiId: 'outro-pai' });
    db.seed('produtos/filho-x/prodshopee/l1', {
      item_id: ITEM_ID,
      contaProdutoShopeeOuterRef: REF_CONTA,
    });

    await expect(importarAnuncioShopee(deps(db), anuncioSimples())).rejects.toMatchObject({
      motivo: 'vinculo-inconsistente',
    });
    expect(db.writes).toEqual([]);
  });

  it('`taxonomia-em-conflito` — a SEGUNDA perda recusa, e nenhum produto foi escrito', async () => {
    const db = new FakeDb();
    semearGrupoCor(db);
    // Um vencedor permanente: todo `update` guardado do grupo perde.
    db.falhasDeUpdate.set('grupoDeVariacoes/g-cor', grpc(9, 'FAILED_PRECONDITION'));

    await expect(
      importarAnuncioShopee(
        deps(db),
        item(
          { has_model: true },
          modelos(
            [
              { model_id: MODEL_A, tier_index: [0], price_info: PRECO_BRL },
              { model_id: MODEL_B, tier_index: [1], price_info: PRECO_BRL },
            ],
            TIER_COR,
          ),
        ),
      ),
    ).rejects.toMatchObject({ motivo: 'taxonomia-em-conflito', itemId: ITEM_ID });

    expect(db.writes.filter((w) => w.path.startsWith('produtos/'))).toEqual([]);
    // Duas leituras do memo: a perda REPLANEJA contra um memo NOVO.
    expect(consultasDeGrupo(db)).toHaveLength(2);
  });

  it('uma perda ÚNICA relê, REPLANEJA e importa — o retry nunca reaplica o mesmo patch', async () => {
    const db = new FakeDb();
    semearGrupoCor(db);
    const original = db.falhasDeUpdate.get.bind(db.falhasDeUpdate);
    let restantes = 1;
    vi.spyOn(db.falhasDeUpdate, 'get').mockImplementation((chave: string) => {
      if (chave === 'grupoDeVariacoes/g-cor' && restantes > 0) {
        restantes -= 1;
        return grpc(9, 'FAILED_PRECONDITION');
      }
      return original(chave);
    });

    const resultado = await importarAnuncioShopee(
      deps(db),
      item(
        { has_model: true },
        modelos(
          [
            { model_id: MODEL_A, tier_index: [0], price_info: PRECO_BRL },
            { model_id: MODEL_B, tier_index: [1], price_info: PRECO_BRL },
          ],
          TIER_COR,
        ),
      ),
    );

    expect(resultado.variacoes.total).toBe(2);
    expect(consultasDeGrupo(db)).toHaveLength(2);
    expect(db.store['grupoDeVariacoes/g-cor']?.data.campoSoDoFlutter).toBe('não modelado aqui');
  });

  it('um KIT é recusado com um `Error` simples ANTES de qualquer leitura', async () => {
    const db = new FakeDb();
    const entrada = anuncioSimples({ tag: { kit: true } });

    await expect(importarAnuncioShopee(deps(db), entrada)).rejects.toThrow('importarKitShopee');
    await expect(importarAnuncioShopee(deps(db), entrada)).rejects.not.toBeInstanceOf(
      ShopeeImportBlockedError,
    );
    expect(db.caminhos).toEqual([]);
    expect(db.writes).toEqual([]);
  });
});

/* ------------------------ 4. a reimportação idêntica ---------------------- */

describe('importarAnuncioShopee — a reimportação byte-idêntica', () => {
  it('não produz patch de produto e o grupo não mudou', async () => {
    const db = new FakeDb();
    const entrada = anuncioDeDoisTiers();
    await importarAnuncioShopee(deps(db), entrada);
    const paiId = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);
    const filhos = [MODEL_A, MODEL_B].map((m) => idDoFilhoPlanejado(paiId, m));

    const plano = await prepararImportacaoShopee(deps(db), entrada);
    expect(plano.produtoPai).toBeNull();
    expect(plano.filhos.map((f) => f.produto)).toEqual([null, null]);
    expect(plano.taxonomia.every((g) => !g.criar && g.patch === null)).toBe(true);

    const escritasAntes = db.writes.length;
    await importarAnuncioShopee(deps(db), entrada);
    const segunda = passos(db, paiId, filhos).slice(escritasAntes);

    // Sobram as escritas idempotentes: os dois vínculos e o preço (set-only).
    expect(segunda).not.toContain('produto-pai');
    expect(segunda).not.toContain('taxonomia');
    expect(segunda).toEqual([
      'link-pai',
      'preco-filho0',
      'link-filho0',
      'preco-filho1',
      'link-filho1',
    ]);
  });
});

/* ------------------------ 5. o importador não chama a Shopee -------------- */

describe('importarAnuncioShopee — nenhuma chamada de anúncio', () => {
  it('recebe o `ItemLido` pronto: só a ÁRVORE de categorias é lida', async () => {
    const db = new FakeDb();

    await importarAnuncioShopee(deps(db), anuncioDeDoisTiers());

    expect(cliente.chamadas).toEqual(['getCategory']);
  });
});

/* ----------------------------- 6. os modelos ------------------------------ */

describe('importarAnuncioShopee — os modelos', () => {
  it('`model_id: 0` cria o filho, NÃO escreve vínculo e conta `semLink: 1`', async () => {
    const db = new FakeDb();
    const paiId = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);

    const resultado = await importarAnuncioShopee(
      deps(db),
      item(
        { has_model: true },
        modelos(
          [{ model_id: 0, tier_index: [0], model_sku: 'CAM-001-AZ', price_info: PRECO_BRL }],
          TIER_COR,
        ),
      ),
    );

    const filhoId = idDoFilhoPlanejado(paiId, 0);
    expect(db.store[`produtos/${filhoId}`]?.data.paiId).toBe(paiId);
    expect(db.writes.filter((w) => w.path.includes('/variashopee/'))).toEqual([]);
    expect(resultado.variacoes).toMatchObject({ total: 1, criadas: 1, semLink: 1 });
  });

  it('um anúncio SEM modelos não escreve nenhum `variashopee`', async () => {
    const db = new FakeDb();

    const resultado = await importarAnuncioShopee(deps(db), anuncioSimples());

    expect(db.writes.filter((w) => w.path.includes('/variashopee/'))).toEqual([]);
    expect(resultado.variacoes).toMatchObject({ total: 0, criadas: 0, semLink: 0 });
  });

  it('um anúncio de UM modelo vira pai + UM filho, com o `sku` = `model_sku` verbatim', async () => {
    const db = new FakeDb();
    const paiId = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);

    await importarAnuncioShopee(
      deps(db),
      item(
        { has_model: true },
        modelos(
          [
            {
              model_id: MODEL_A,
              tier_index: [0],
              model_sku: 'CAM-001-AZ',
              price_info: PRECO_BRL,
            },
          ],
          TIER_COR,
        ),
      ),
    );

    const filhoId = idDoFilhoPlanejado(paiId, MODEL_A);
    // ⛔ Nunca um sufixo de membro único: o `sku` do filho é o do modelo, inteiro.
    expect(db.store[`produtos/${filhoId}`]?.data.sku).toBe('CAM-001-AZ');
    expect(db.store[`produtos/${paiId}`]?.data.filhoUnicoId).toBe(filhoId);
  });
});

/* ------------------------------ 7. o resultado ---------------------------- */

describe('importarAnuncioShopee — os contadores', () => {
  it('reporta o produto criado, o nome e os três blocos', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();

    const resultado = await importarAnuncioShopee(
      deps(db, {
        options: opcoes(),
        bucket: asBucket(bucket),
        fetchImpl: fetchDeFoto(),
      }),
      item(
        {
          has_model: true,
          image: { image_url_list: [URL_FOTO], image_id_list: ['img-1'] },
        },
        modelos([
          { model_id: MODEL_A, tier_index: [0, 0], price_info: PRECO_BRL },
          { model_id: MODEL_B, tier_index: [1, 0], price_info: PRECO_BRL },
        ]),
      ),
    );

    expect(resultado).toMatchObject({
      produtoId: idDoPaiPlanejado(INTEGRACAO, ITEM_ID),
      criado: true,
      nome: 'Camiseta Básica',
      variacoes: { total: 2, criadas: 2, semLink: 0 },
      fotos: { importadas: 1, ignoradas: 0, falhas: 0 },
    });
    // O endereçamento por conteúdo: o id do arquivo é o sha512 dos bytes que
    // subiram, e é por ele que uma reimportação não sobe a mesma foto de novo.
    const arquivoId = productArquivoId(idDoPaiPlanejado(INTEGRACAO, ITEM_ID), HASH_FOTO);
    expect(bucket.saved[0]?.bytes.toString()).toBe(BYTES_FOTO.toString());
    expect(db.store[`arquivos/${arquivoId}`]).toBeDefined();
  });

  it('`criado` vira FALSE quando a criação perde para um ALREADY_EXISTS', async () => {
    const db = new FakeDb();
    const paiId = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);
    // Outro gravador criou o documento no id determinístico — e com um `sku`
    // que a rung 2 não casa, para que a cascata continue não resolvendo nada.
    db.seed(`produtos/${paiId}`, { nome: 'De outro', sku: 'OUTRO-SKU', paiId: null });

    const resultado = await importarAnuncioShopee(deps(db), anuncioSimples());

    expect(resultado.criado).toBe(false);
    expect(resultado.produtoId).toBe(paiId);
  });
});

/* -------------------------------- 8. os memos ----------------------------- */

describe('importarAnuncioShopee — o memo do despacho', () => {
  it('dois anúncios com o MESMO deps fazem UMA leitura de `grupoDeVariacoes`', async () => {
    const db = new FakeDb();
    const compartilhado = deps(db, { grupos: criarMemoDeGrupos(asDb(db)) });

    await importarAnuncioShopee(
      compartilhado,
      anuncioComModelosSemTiers(ITEM_ID, 'CAM-001', MODEL_A),
    );
    await importarAnuncioShopee(
      compartilhado,
      anuncioComModelosSemTiers(OUTRO_ITEM_ID, 'CAM-002', MODEL_B),
    );

    expect(consultasDeGrupo(db)).toHaveLength(1);
  });

  it('⚠️ o memo ENVELHECE: um anúncio que cria um grupo faz o SEGUINTE replanejar', async () => {
    // Não é um defeito de correção — o retry relê e o item entra — mas é o
    // custo real do memo por DESPACHO, e ele gasta a única retentativa do
    // segundo item. Fixado aqui para que uma mudança no memo seja deliberada.
    const db = new FakeDb();
    const compartilhado = deps(db, { grupos: criarMemoDeGrupos(asDb(db)) });

    await importarAnuncioShopee(compartilhado, anuncioDeDoisTiers());
    const resultado = await importarAnuncioShopee(
      compartilhado,
      item(
        { item_id: OUTRO_ITEM_ID, item_sku: 'CAM-002', has_model: true },
        modelos([{ model_id: 2000458804, tier_index: [0, 0], price_info: PRECO_BRL }]),
      ),
    );

    expect(resultado.variacoes.total).toBe(1);
    expect(consultasDeGrupo(db)).toHaveLength(2);
  });

  it('⛔ um anúncio SEM modelos não lê `grupoDeVariacoes` nenhuma vez', async () => {
    const db = new FakeDb();

    await importarAnuncioShopee(
      deps(db, { grupos: criarMemoDeGrupos(asDb(db)) }),
      anuncioSimples(),
    );

    expect(consultasDeGrupo(db)).toEqual([]);
  });

  it('um deps NOVO lê de novo — é assim que uma retentativa enxerga quem venceu', async () => {
    const db = new FakeDb();
    const entrada = anuncioComModelosSemTiers(ITEM_ID, 'CAM-001', MODEL_A);

    await importarAnuncioShopee(deps(db, { grupos: criarMemoDeGrupos(asDb(db)) }), entrada);
    await importarAnuncioShopee(deps(db, { grupos: criarMemoDeGrupos(asDb(db)) }), entrada);

    expect(consultasDeGrupo(db)).toHaveLength(2);
  });
});
