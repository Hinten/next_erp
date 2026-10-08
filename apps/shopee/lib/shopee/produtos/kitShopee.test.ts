import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  shopeeCategoriaSchema,
  shopeeItemBaseInfoPayloadSchema,
  shopeeItemBaseInfoRowSchema,
  shopeeItemBaseInfoSchema,
  shopeeKitItemInfoSchema,
  shopeeKitItemSchema,
  type ShopeeCategoria,
  type ShopeeClient,
  type ShopeeKitItem,
} from '@delfrance/integrations-shopee';
import {
  MOTIVO_RESOLUCAO_RECEITA_KIT,
  chaveAvisoReceitaKitShopee,
  chaveReceitaKitErp,
  importacaoShopeeOptionsSchema,
  productArquivoId,
  toOuterRef,
  type ImportacaoShopeeOptions,
} from '@delfrance/schemas';
import { avisoCollection } from '@delfrance/data/admin/collections';
import { reavaliarAvisoDeReceitaKit } from '@delfrance/data/admin/avisos';

import { kitNativoDoAnuncio } from '../anuncios/montagemAnuncio';
import { MOTIVO_ESTOQUE_SHOPEE } from '../estoque/errosEstoque';
import { podeEnviarEstoqueShopee } from '../estoque/podeEnviarEstoque';
import { lerFixture } from '../fixtures/wireCorpus';
import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { FakeBucket, asBucket } from '../testing/fakeBucket';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { criarMemoDeCategorias } from './categoriaShopee';
import { ShopeeImportBlockedError } from './errosImportacao';
import { idDaVariacaoDeKit, idDoVinculoDeKit } from '../kits/idsKit';
import {
  anuncioDerivadoDoKit,
  chaveDoPaiDaFamiliaDeUm,
  comCamposDeKit,
  decidirReceitaDoFilho,
  ehTierDeKitUnico,
  idDoVinculoDaListagemDeKit,
  importarKitShopee,
  lerCarimbosContados,
  preCarimbarLinhasDoKit,
  prepararImportacaoKitShopee,
  receitaFielAosEnderecos,
  resolverComponentesDoKit,
  type ComponenteDoKitShopee,
} from './kitShopee';
import type { PlanoImportacaoShopee } from './planoImportacao';
import type { ImportarKitShopeeDeps, ItemLido } from './itemLido';
import { lerAnuncioShopee } from './lerAnuncio';
import { idDoFilhoPlanejado, idDoPaiPlanejado } from './resolveProduto';

/* ---------------------------------- fixtures ------------------------------ */

/**
 * ⚠️ O plano de LISTAGEM que a transformação de kit recebe, com estoque no pai e
 * no filho. Ele não é alcançável pelo caminho real — a tradução do kit nunca
 * emite `stock_info_v2`, então o planejador compartilhado nunca planeja estoque
 * —, e é exatamente por isso que o par cinto-e-suspensório só pode ser fixado
 * metade a metade.
 */
function planoDeListagemComEstoque(): PlanoImportacaoShopee {
  return {
    itemId: 2500139861,
    produtoId: 'pai-x',
    produtoPai: { produtoId: 'pai-x', criar: false, data: { nome: 'Kit' } },
    estoquePai: { produtoId: 'pai-x', docId: 'est-pai', criar: true, data: { quantidade: 7 } },
    linkPai: { acao: 'add', docId: null, dados: { item_id: 2500139861, kitNativo: true } },
    filhoUnico: { paiId: 'pai-x', idsPlanejados: ['filho-x'] },
    filhos: [
      {
        modelId: 2000458802,
        produto: { produtoId: 'filho-x', criar: false, data: { nome: 'Kit A' } },
        estoque: { produtoId: 'filho-x', docId: 'est-f', criar: true, data: { quantidade: 7 } },
        link: null,
      },
    ],
  } as unknown as PlanoImportacaoShopee;
}

const ITEM_ID = 2500139861;
const COMPONENTE_A = 2500139862;
const COMPONENTE_B = 2500139863;
const MODEL_A = 2000458802;
const MODEL_B = 2000458803;
const MODEL_C = 2000458804;
const MODEL_COMPONENTE = 2000458810;
const INTEGRACAO = 'int-1';
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;
const TABELA_NORMAL = 'documents/listaDePrecos/tab-normal';
const TABELA_NORMAL_ID = 'tab-normal';
const TABELA_PROMOCIONAL = 'documents/listaDePrecos/tab-promo';
const TABELA_PROMOCIONAL_ID = 'tab-promo';
const DEPOSITO = 'documents/depositos/dep-1';
const AGORA = 1_757_000_000_000;

const PAI_ID = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);

const URL_FOTO = 'https://cf.shopee.com.br/file/foto-do-kit';
const BYTES_FOTO = Buffer.from('bytes de uma imagem que ninguém decodifica');
const HASH_FOTO = createHash('sha512').update(BYTES_FOTO).digest('hex');

/** `Roupas > Camisetas > Manga Curta` — o mesmo galho dos testes de anúncio. */
const ARVORE: ShopeeCategoria[] = [
  { category_id: 100001, parent_category_id: 0, display_category_name: 'Roupas' },
  { category_id: 100009, parent_category_id: 100001, display_category_name: 'Camisetas' },
  { category_id: 100017, parent_category_id: 100009, display_category_name: 'Manga Curta' },
].map((c) => shopeeCategoriaSchema.parse({ has_children: false, ...c }));

function opcoes(parcial: Partial<ImportacaoShopeeOptions> = {}): ImportacaoShopeeOptions {
  return importacaoShopeeOptionsSchema.parse(parcial);
}

/** Um componente de uma model de kit, na grafia da PÁGINA DO KIT. */
function componente(parcial: Record<string, unknown>): Record<string, unknown> {
  return { component_item_id: COMPONENTE_A, component_model_id: 0, quantity: 1, ...parcial };
}

function kit(parcial: Record<string, unknown> = {}): ShopeeKitItem {
  return shopeeKitItemSchema.parse({
    item_id: ITEM_ID,
    item_name: 'Kit Camiseta + Boné',
    item_sku: 'KIT-001',
    // ⚠️ ESCALAR — a página declara `int64[]` e a amostra manda um número.
    category_id: 100017,
    weight: '0.8',
    model_list: [
      {
        model_id: MODEL_A,
        model_sku: 'KIT-001-A',
        original_price: 99.9,
        component_list: [componente({})],
      },
    ],
    ...parcial,
  });
}

/** O {@link ItemLido} que o job monta para um kit: base MÍNIMA + a página do kit. */
function entradaDeKit(detalhe: ShopeeKitItem | null): ItemLido {
  return {
    base: shopeeItemBaseInfoRowSchema.parse({ item_id: ITEM_ID, tag: { kit: true } }),
    models: null,
    taxInfo: null,
    kit: detalhe,
    itemId: ITEM_ID,
  };
}

/**
 * Um cliente Shopee que LANÇA em toda propriedade — e registra o acesso, porque
 * alcançar o método já é o defeito, tenha o teste esperado a promessa ou não.
 */
interface ClienteDeTeste {
  readonly client: ShopeeClient;
  readonly chamadas: string[];
}

function clienteQueRecusa(comCategorias: boolean): ClienteDeTeste {
  const chamadas: string[] = [];
  const client = new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      if (typeof prop !== 'string') return undefined;
      chamadas.push(prop);
      if (comCategorias && prop === 'getCategory') {
        return () => Promise.resolve({ category_list: [...ARVORE] });
      }
      return () => {
        throw new Error(`o importador de kit chamou a Shopee: ${prop}`);
      };
    },
  }) as unknown as ShopeeClient;
  return { client, chamadas };
}

let cliente = clienteQueRecusa(true);

beforeEach(() => {
  limparTaxonomiaShopee();
  cliente = clienteQueRecusa(true);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

function deps(db: FakeDb, parcial: Partial<ImportarKitShopeeDeps> = {}): ImportarKitShopeeDeps {
  return {
    db: asDb(db),
    increment,
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

/** Um fetch que serve {@link BYTES_FOTO} como PNG. */
function fetchDeFoto(): typeof globalThis.fetch {
  return (() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: () => Promise.resolve(Uint8Array.from(BYTES_FOTO).buffer),
    })) as unknown as typeof globalThis.fetch;
}

/** Um produto simples que um componente resolve por VÍNCULO de listagem. */
function semearComponentePorListagem(db: FakeDb, produtoId: string, itemId: number): void {
  db.seed(`produtos/${produtoId}`, {
    nome: `Componente ${produtoId}`,
    sku: produtoId,
    paiId: null,
  });
  db.seed(`produtos/${produtoId}/prodshopee/vinc-${String(itemId)}`, {
    item_id: itemId,
    contaProdutoShopeeOuterRef: REF_CONTA,
  });
}

/** Um FILHO que um componente resolve por vínculo de VARIAÇÃO. */
function semearComponentePorVariacao(db: FakeDb, produtoId: string, modelId: number): void {
  db.seed(`produtos/${produtoId}`, {
    nome: `Variação ${produtoId}`,
    sku: produtoId,
    paiId: 'algum-pai',
  });
  db.seed(`produtos/${produtoId}/variashopee/vinc-${String(modelId)}`, {
    model_id: modelId,
    contaVariacaoShopeeOuterRef: REF_CONTA,
  });
}

/** Os passos de escrita, rotulados — uma SEQUÊNCIA, não um conjunto. */
function passos(db: FakeDb, filhos: readonly string[] = []): string[] {
  return db.writes.map((w) => {
    const chaves = Object.keys(w.patch);
    if (w.path.startsWith('grupoDeVariacoes/')) return 'taxonomia';
    if (w.path.startsWith('categorias/')) return 'categoria';
    if (w.path.startsWith('arquivos/')) return 'arquivo';
    if (w.path === `produtos/${PAI_ID}`) {
      if (chaves.some((k) => k.startsWith('precos.'))) return 'preco-pai';
      if (chaves.length === 2 && chaves.includes('fotos') && chaves.includes('fotosArquivosIds')) {
        return 'fotos-pai';
      }
      if (
        chaves.length === 2 &&
        chaves.includes('filhoUnicoId') &&
        chaves.includes('ultimaModificacao')
      ) {
        return 'filho-unico';
      }
      return 'produto-pai';
    }
    // Step 19: the recipe aviso's shared decision, after the writer (R-4).
    if (w.path.startsWith('avisos/')) return 'aviso';
    if (w.path.startsWith(`produtos/${PAI_ID}/extraData/`)) return 'extraData';
    if (w.path.startsWith(`produtos/${PAI_ID}/estoques/`)) return 'estoque-pai';
    if (w.path.startsWith(`produtos/${PAI_ID}/prodshopee/`)) return 'link-pai';
    for (const [i, id] of filhos.entries()) {
      if (w.path === `produtos/${id}`) return `produto-filho${String(i)}`;
      if (w.path.startsWith(`produtos/${id}/estoques/`)) return `estoque-filho${String(i)}`;
      if (w.path.startsWith(`produtos/${id}/variashopee/`)) return `link-filho${String(i)}`;
    }
    return `?? ${w.path}`;
  });
}

function docDoProduto(db: FakeDb, produtoId: string): Record<string, unknown> {
  return (db.store[`produtos/${produtoId}`]?.data ?? {}) as Record<string, unknown>;
}

/** Os `prodshopee` gravados sob o pai do kit — caminho e dados. */
function vinculosDoPai(db: FakeDb): { caminho: string; dados: Record<string, unknown> }[] {
  return Object.entries(db.store)
    .filter(([p]) => p.startsWith(`produtos/${PAI_ID}/prodshopee/`))
    .map(([caminho, doc]) => ({ caminho, dados: doc.data as Record<string, unknown> }));
}

function escritasDeEstoque(db: FakeDb): string[] {
  return db.writes.filter((w) => w.path.includes('/estoques/')).map((w) => w.path);
}

/* ------------------------------ 1. as recusas ----------------------------- */

describe('importarKitShopee — as recusas', () => {
  it('um kit sem product_info recusa com kit-sem-detalhe e não escreve NADA', async () => {
    const db = new FakeDb();

    const erro = await importarKitShopee(deps(db), entradaDeKit(null)).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeImportBlockedError);
    expect((erro as ShopeeImportBlockedError).motivo).toBe('kit-sem-detalhe');
    expect((erro as ShopeeImportBlockedError).itemId).toBe(ITEM_ID);
    expect(db.writes).toEqual([]);
  });

  it('um componente sem vínculo recusa nomeando modelo, item e modelo do componente', async () => {
    const db = new FakeDb();
    // O primeiro componente resolve; o SEGUNDO não — e é ele que a mensagem nomeia.
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);

    const detalhe = kit({
      model_list: [
        {
          model_id: MODEL_A,
          model_sku: 'KIT-001-A',
          original_price: 99.9,
          component_list: [
            componente({}),
            componente({ component_item_id: COMPONENTE_B, component_model_id: MODEL_COMPONENTE }),
          ],
        },
      ],
    });

    const erro = await importarKitShopee(deps(db), entradaDeKit(detalhe)).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeImportBlockedError);
    expect((erro as ShopeeImportBlockedError).motivo).toBe('kit-componente-nao-vinculado');
    expect((erro as ShopeeImportBlockedError).mensagem).toBe(
      `modelo ${String(MODEL_A)}, componente item ${String(COMPONENTE_B)}/modelo ${String(
        MODEL_COMPONENTE,
      )}`,
    );
    // ⚠️ A recusa vem ANTES de qualquer escrita — nenhum produto meio-criado.
    expect(db.writes).toEqual([]);
  });

  it('⛔ o preparo não escreve nada NEM quando todos os componentes resolvem', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);

    const preparo = await prepararImportacaoKitShopee(deps(db), entradaDeKit(kit()));

    expect(preparo.plano.produtoId).toBe(PAI_ID);
    expect(db.writes).toEqual([]);
  });

  it('o importador de kit não emite NENHUMA chamada à Shopee', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const recusa = clienteQueRecusa(false);

    // Sem memo de categorias: a única leitura de rede que o importador poderia
    // fazer é a árvore, e aqui ela nem existe — a página do kit já veio pronta.
    await importarKitShopee(
      { ...deps(db), categorias: undefined },
      entradaDeKit(kit({ category_id: null })),
    );

    expect(recusa.chamadas).toEqual([]);
  });
});

/* -------------------------- 2. ehKit e a composição ----------------------- */

describe('importarKitShopee — ehKit e componentesKit', () => {
  it('todos os componentes resolvidos ⇒ o PAI carrega ehKit true', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);

    await importarKitShopee(deps(db), entradaDeKit(kit()));

    expect(docDoProduto(db, PAI_ID).ehKit).toBe(true);
  });

  it('⛔ um kit de 1 model NÃO deixa o pai com ehKit false', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const filhoId = idDoFilhoPlanejado(PAI_ID, MODEL_A);

    await importarKitShopee(deps(db), entradaDeKit(kit()));

    // O pai é quem a cascata de pedido vincula para um kit: um `false` aqui
    // mandaria a linha para o membro único, que é uma CÓPIA da composição.
    expect(docDoProduto(db, PAI_ID).ehKit).toBe(true);
    expect(docDoProduto(db, filhoId).ehKit).toBe(true);
    expect(docDoProduto(db, PAI_ID).filhoUnicoId).toBe(filhoId);
  });

  it('um kit de 1 model ESPELHA o mesmo componentesKit no pai e no filho', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const filhoId = idDoFilhoPlanejado(PAI_ID, MODEL_A);

    await importarKitShopee(deps(db), entradaDeKit(kit()));

    const esperado = { 'comp-a': { quantidade: 1, limitarEstoque: true, timestamp: AGORA } };
    expect(docDoProduto(db, PAI_ID).componentesKit).toEqual(esperado);
    expect(docDoProduto(db, filhoId).componentesKit).toEqual(esperado);
    expect(docDoProduto(db, PAI_ID).componentesKitKeys).toEqual(['comp-a']);
  });

  it('um kit de 3 models deixa o pai com componentesKit null e cada filho com o SEU mapa', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    semearComponentePorVariacao(db, 'comp-b', MODEL_COMPONENTE);
    const detalhe = kit({
      model_list: [
        { model_id: MODEL_A, model_sku: 'K-A', component_list: [componente({ quantity: 2 })] },
        {
          model_id: MODEL_B,
          model_sku: 'K-B',
          component_list: [
            componente({ component_item_id: COMPONENTE_B, component_model_id: MODEL_COMPONENTE }),
          ],
        },
        {
          model_id: MODEL_C,
          model_sku: 'K-C',
          component_list: [
            componente({}),
            componente({ component_item_id: COMPONENTE_B, component_model_id: MODEL_COMPONENTE }),
          ],
        },
      ],
    });

    await importarKitShopee(deps(db), entradaDeKit(detalhe));

    expect(docDoProduto(db, PAI_ID).ehKit).toBe(true);
    // Não há UMA composição para espelhar — e uma mistura das três seria uma
    // quarta resposta que ninguém escreveu.
    expect(docDoProduto(db, PAI_ID).componentesKit).toBeNull();
    expect(docDoProduto(db, PAI_ID).componentesKitKeys).toBeNull();

    const [a, b, c] = [MODEL_A, MODEL_B, MODEL_C].map((m) =>
      docDoProduto(db, idDoFilhoPlanejado(PAI_ID, m)),
    );
    expect(a?.componentesKit).toEqual({
      'comp-a': { quantidade: 2, limitarEstoque: true, timestamp: AGORA },
    });
    expect(b?.componentesKit).toEqual({
      'comp-b': { quantidade: 1, limitarEstoque: true, timestamp: AGORA },
    });
    expect(Object.keys(c?.componentesKit as Record<string, unknown>).sort()).toEqual([
      'comp-a',
      'comp-b',
    ]);
    expect(a?.ehKit).toBe(true);
    expect(b?.ehKit).toBe(true);
    expect(c?.ehKit).toBe(true);
  });

  it('duas linhas que resolvem no MESMO produto somam a quantidade', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const detalhe = kit({
      model_list: [
        {
          model_id: MODEL_A,
          model_sku: 'K-A',
          component_list: [componente({ quantity: 2 }), componente({ quantity: 3 })],
        },
      ],
    });

    await importarKitShopee(deps(db), entradaDeKit(detalhe));

    const mapa = docDoProduto(db, PAI_ID).componentesKit as Record<string, { quantidade: number }>;
    // ⛔ 5, e nunca 3: um mapa por produto não consegue guardar as duas linhas,
    // então SOBRESCREVER perderia a primeira em silêncio.
    expect(mapa['comp-a']?.quantidade).toBe(5);
    expect(mapa['comp-a']?.quantidade).not.toBe(3);
    expect(Object.keys(mapa)).toEqual(['comp-a']);
  });

  it('componentesKitKeys é exatamente Object.keys(componentesKit)', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    semearComponentePorVariacao(db, 'comp-b', MODEL_COMPONENTE);
    const detalhe = kit({
      model_list: [
        {
          model_id: MODEL_A,
          model_sku: 'K-A',
          component_list: [
            componente({}),
            componente({ component_item_id: COMPONENTE_B, component_model_id: MODEL_COMPONENTE }),
          ],
        },
      ],
    });

    await importarKitShopee(deps(db), entradaDeKit(detalhe));

    const doc = docDoProduto(db, PAI_ID);
    expect(doc.componentesKitKeys).toEqual(
      Object.keys(doc.componentesKit as Record<string, unknown>),
    );
    expect(doc.componentesKitKeys).toEqual(['comp-a', 'comp-b']);
  });

  it('um componente de FAMÍLIA DE UM resolve na unidade vendável, não no pai', async () => {
    const db = new FakeDb();
    // Sem vínculo nenhum: o componente cai na cascata de SKU, e a raiz achada é
    // um invólucro cuja unidade vendável é o filho.
    db.seed('produtos/fam-pai', {
      nome: 'Camiseta',
      sku: 'COMP-FAM',
      paiId: null,
      filhoUnicoId: 'fam-filho',
    });
    db.seed('produtos/fam-filho', { nome: 'Camiseta', sku: null, paiId: 'fam-pai' });

    const detalhe = kit({
      model_list: [
        {
          model_id: MODEL_A,
          model_sku: 'K-A',
          component_list: [componente({ component_item_or_model_sku: 'COMP-FAM' })],
        },
      ],
    });
    const componentes = await resolverComponentesDoKit(asDb(db), INTEGRACAO, detalhe, new Map());

    expect(componentes[0]?.produtoId).toBe('fam-filho');
    expect(componentes[0]?.via).toBe('sku-membro-unico');

    await importarKitShopee(deps(db), entradaDeKit(detalhe));
    expect(Object.keys(docDoProduto(db, PAI_ID).componentesKit as Record<string, unknown>)).toEqual(
      ['fam-filho'],
    );
  });
});

/* --------------------------- 3. estoque e preços -------------------------- */

describe('importarKitShopee — estoque e preços', () => {
  it('⛔ NENHUMA linha de estoque é criada, mesmo com importarEstoque ligado', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    // A página do kit não traz estoque em lugar nenhum; aqui ela traz — pelo
    // `.passthrough()` — e ainda assim nada pode ser estocado.
    const detalhe = kit({
      stock_info_v2: { seller_stock: [{ location_id: 'BR', stock: 7 }] },
      model_list: [
        {
          model_id: MODEL_A,
          model_sku: 'K-A',
          original_price: 99.9,
          stock_info_v2: { seller_stock: [{ location_id: 'BR', stock: 7 }] },
          component_list: [componente({})],
        },
      ],
    });

    await importarKitShopee(
      deps(db, { options: opcoes({ importarEstoque: true, sobrescreverEstoque: true }) }),
      entradaDeKit(detalhe),
    );

    expect(escritasDeEstoque(db)).toEqual([]);
  });

  it('⛔ a TRADUÇÃO nunca emite `stock_info_v2` — nem no pai, nem em modelo nenhum', () => {
    // ⚠️ Metade das "suspensórios" do par, fixada SOZINHA. O teste acima não a
    // alcança: os overrides `estoque: null` da transformação de kit absorvem
    // qualquer estoque que vazasse por aqui, então os dois se cobrem e nenhum
    // dos dois fica preso. A página do kit não traz estoque nenhum e inventar um
    // é a única coisa que a leitura do kit proíbe explicitamente.
    const detalhe = kit({
      stock_info_v2: { seller_stock: [{ location_id: 'BR', stock: 7 }] },
      model_list: [
        {
          model_id: MODEL_A,
          model_sku: 'K-A',
          original_price: 99.9,
          stock_info_v2: { seller_stock: [{ location_id: 'BR', stock: 7 }] },
          component_list: [componente({})],
        },
      ],
    });

    const derivado = anuncioDerivadoDoKit(entradaDeKit(detalhe), detalhe);

    expect(derivado.base.stock_info_v2).toBeNull();
    expect(derivado.models?.model.map((m) => m.stock_info_v2)).toEqual([null]);
    // ÂNCORA: a tradução realmente leu essa página — o resto do modelo chegou.
    expect(derivado.models?.model.map((m) => m.model_sku)).toEqual(['K-A']);
  });

  it('⛔ o CINTO: a transformação de kit zera o estoque do pai e o de cada filho', () => {
    // A outra metade, fixada sozinha pelo mesmo motivo — e aqui a entrada é um
    // plano de listagem COM estoque, que o caminho real nunca produz para um kit.
    const componentes: ComponenteDoKitShopee[] = [
      {
        modelId: 2000458802,
        itemId: COMPONENTE_A,
        modelIdDoComponente: 0,
        sku: null,
        quantidade: 1,
        produtoId: 'comp-a',
        via: 'prodshopee',
      },
    ];

    const plano = comCamposDeKit(planoDeListagemComEstoque(), componentes, AGORA, INTEGRACAO, {
      pai: null,
      filhos: [null],
      carimbosContados: [[]],
    });

    expect(plano.estoquePai).toBeNull();
    expect(plano.filhos.map((f) => f.estoque)).toEqual([null]);
    // ÂNCORA: a transformação realmente rodou sobre este plano.
    expect(plano.produtoPai?.data.ehKit).toBe(true);
    expect(plano.filhos[0]?.produto?.data.componentesKit).toEqual({
      'comp-a': { quantidade: 1, limitarEstoque: true, timestamp: AGORA },
    });
  });

  it('o preço vai para a tabela NORMAL — no FILHO e, sendo um preço só, também no PAI — só com importarPreco', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const filhoId = idDoFilhoPlanejado(PAI_ID, MODEL_A);

    await importarKitShopee(
      deps(db, {
        tabelaPromocionalOuterRef: TABELA_PROMOCIONAL,
        options: opcoes({ importarFotos: false, importarPreco: true }),
      }),
      entradaDeKit(kit()),
    );

    const filho = docDoProduto(db, filhoId);
    expect(filho.precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 99.9 } });
    // ⛔ A tabela promocional pertence às promoções que o operador cria no ERP —
    // a importação NUNCA a escreve, tenha a conta uma ou não.
    expect(JSON.stringify(db.writes)).not.toContain(TABELA_PROMOCIONAL_ID);
    // O kit de UM model é uma família de um preço só (a regra da família,
    // Lucas 2026-09-28): o pai recebe esse preço e a propagação LIGADA.
    expect(docDoProduto(db, PAI_ID).precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 99.9 } });
    expect(docDoProduto(db, PAI_ID).propagatePriceToChildren).toBe(true);
  });

  it('com importarPreco desligado nenhum preço é planejado', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const filhoId = idDoFilhoPlanejado(PAI_ID, MODEL_A);

    await importarKitShopee(
      deps(db, { options: opcoes({ importarFotos: false, importarPreco: false }) }),
      entradaDeKit(kit()),
    );

    expect(docDoProduto(db, filhoId).precos).toBeNull();
  });

  it('⛔ um preço de kit em moeda NÃO-BRL não planeja preço nenhum', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const filhoId = idDoFilhoPlanejado(PAI_ID, MODEL_A);
    // Uma moeda DECLARADA vence a moeda assumida: o `price_info` sobrevive ao
    // `.passthrough()` e o leitor compartilhado responde `moeda-nao-brl`.
    const detalhe = kit({
      model_list: [
        {
          model_id: MODEL_A,
          model_sku: 'K-A',
          original_price: 99.9,
          price_info: [{ currency: 'SGD', original_price: 99.9 }],
          component_list: [componente({})],
        },
      ],
    });

    await importarKitShopee(deps(db), entradaDeKit(detalhe));

    expect(docDoProduto(db, filhoId).precos).toBeNull();
  });
});

/* ------------------------------ 4. os vínculos ---------------------------- */

describe('importarKitShopee — os vínculos', () => {
  it('o vínculo do pai carrega attributes, brand_id e category_id nas grafias da PÁGINA DO KIT', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    // ⛔ As grafias da página do ITEM (`attribute_list`, `brand`, `pre_order`)
    // não chegam aqui: um leitor escrito para elas gravaria `null` em todas.
    const detalhe = kit({
      attributes: [{ attribute_id: 100, original_attribute_name: 'Material' }],
      brand_info: { brand_id: 777, original_brand_name: 'Delfrance' },
      pre_order_info: { is_pre_order: true, days_to_ship: 9 },
      category_id: [100017],
    });

    await importarKitShopee(deps(db), entradaDeKit(detalhe));

    const vinculo = Object.entries(db.store).find(([p]) =>
      p.startsWith(`produtos/${PAI_ID}/prodshopee/`),
    );
    const dados = (vinculo?.[1].data ?? {}) as Record<string, unknown>;
    expect(dados.item_id).toBe(ITEM_ID);
    expect(dados.brand_id).toBe(777);
    // O ARRAY declarado vira o escalar que o ERP guarda.
    expect(dados.category_id).toBe(100017);
    expect(dados.attributes).toEqual([
      expect.objectContaining({ attribute_id: 100, original_attribute_name: 'Material' }),
    ]);
    expect(dados.contaProdutoShopeeOuterRef).toBe(REF_CONTA);
    // `pre_order_info` chegou na grafia do vínculo, e com ela o `crossdocking`.
    expect(docDoProduto(db, PAI_ID).crossdocking).toBe(9);
  });

  it('model_id 0 cria o filho SEM vínculo, e o resultado conta em semLink', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const detalhe = kit({
      model_list: [
        { model_id: 0, model_sku: 'K-UNICO', original_price: 10, component_list: [componente({})] },
      ],
    });

    const res = await importarKitShopee(deps(db), entradaDeKit(detalhe));

    expect(res.variacoes).toEqual({ total: 1, criadas: 1, semLink: 1 });
    const filhoId = idDoFilhoPlanejado(PAI_ID, 0);
    expect(db.writes.some((w) => w.path.startsWith(`produtos/${filhoId}/variashopee/`))).toBe(
      false,
    );
    // O SKU do filho é o `model_sku` do vendedor, verbatim — sem sufixo nenhum.
    expect(docDoProduto(db, filhoId).sku).toBe('K-UNICO');
  });

  it('o filho de um model com id recebe o seu variashopee apontando para o vínculo do pai', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const filhoId = idDoFilhoPlanejado(PAI_ID, MODEL_A);

    await importarKitShopee(deps(db), entradaDeKit(kit()));

    const [caminhoPai] = Object.keys(db.store).filter((p) =>
      p.startsWith(`produtos/${PAI_ID}/prodshopee/`),
    );
    const vinculoFilho = Object.entries(db.store).find(([p]) =>
      p.startsWith(`produtos/${filhoId}/variashopee/`),
    );
    const dados = (vinculoFilho?.[1].data ?? {}) as Record<string, unknown>;
    expect(dados.model_id).toBe(MODEL_A);
    expect(dados.produtoShopeeOuterRef).toBe(`documents/${String(caminhoPai)}`);
  });
});

/* -------------------- 4b. `kitNativo` no vínculo, e quem o lê -------------- */

describe('importarKitShopee — `kitNativo` no vínculo da listagem', () => {
  it('um kit NATIVO importado grava `kitNativo: true` no prodshopee criado', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);

    await importarKitShopee(deps(db), entradaDeKit(kit()));

    const vinculos = vinculosDoPai(db);
    expect(vinculos).toHaveLength(1);
    expect(vinculos[0]?.dados.kitNativo).toBe(true);
  });

  it('um re-import MANTÉM `kitNativo: true` no MESMO documento, pelo ramo de merge', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    await importarKitShopee(deps(db), entradaDeKit(kit()));
    const [primeiro] = vinculosDoPai(db);
    const escritasDoPrimeiroPasse = db.writes.length;

    await importarKitShopee(deps(db, { nowMs: AGORA + 3_600_000 }), entradaDeKit(kit()));

    const vinculos = vinculosDoPai(db);
    expect(vinculos.map((v) => v.caminho)).toEqual([primeiro?.caminho]);
    expect(vinculos[0]?.dados.kitNativo).toBe(true);
    // O segundo passe ESCREVEU o campo — não é o valor do primeiro sobrevivendo.
    const escritaDoVinculo = db.writes
      .slice(escritasDoPrimeiroPasse)
      .filter((w) => w.path === primeiro?.caminho);
    expect(escritaDoVinculo).toHaveLength(1);
    expect(escritaDoVinculo[0]?.patch.kitNativo).toBe(true);
  });

  it('⛔ um vínculo gravado ANTES do carimbo (null, ausente ou false) CONVERGE para true', async () => {
    for (const armazenado of [null, undefined, false]) {
      const db = new FakeDb();
      semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
      await importarKitShopee(deps(db), entradaDeKit(kit()));
      const [vinculo] = vinculosDoPai(db);
      const { kitNativo: _descartado, ...semOCampo } = vinculo?.dados ?? {};
      db.seed(
        String(vinculo?.caminho),
        armazenado === undefined ? semOCampo : { ...semOCampo, kitNativo: armazenado },
      );

      await importarKitShopee(deps(db), entradaDeKit(kit()));

      expect(vinculosDoPai(db)).toHaveLength(1);
      expect(vinculosDoPai(db)[0]?.dados.kitNativo).toBe(true);
    }
  });

  it('IDA E VOLTA: o vínculo gravado faz o passo 12 pular com `kit-derivado` e o predicado do passo 11 dizer kit nativo', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    await importarKitShopee(deps(db), entradaDeKit(kit()));
    const vinculo = vinculosDoPai(db)[0]?.dados ?? {};
    const produto = docDoProduto(db, PAI_ID);

    // Passo 12 — o veredito que a varredura e o envio manual aplicam ao
    // documento cru.
    expect(podeEnviarEstoqueShopee(vinculo, produto, { nowMs: AGORA })).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.kitDerivado,
    });
    // O passo 11 (recusa de publicação) lê este predicado. Com vínculo, só
    // `kitNativo` decide — nem `ehKitVirtual` falso no produto o desliga. (O
    // passo 13 não pula mais um kit nativo desde o passo 19: ele o planeja e
    // envia o preço por `update_kit_item` — `precos/kitNativoImportado.test.ts`.)
    expect(kitNativoDoAnuncio(vinculo, { ehKitVirtual: false })).toBe(true);
  });
});

/* --------------------------- 5. ordem e idempotência ---------------------- */

describe('importarKitShopee — a ordem de escrita e o re-import', () => {
  it('escreve taxonomia → categorias → produto → vínculos → filho único → fotos', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const filhoId = idDoFilhoPlanejado(PAI_ID, MODEL_A);
    const detalhe = kit({
      images: { image_url_list: [URL_FOTO], image_id_list: ['img-kit-1'] },
      tier_variation_list: [{ name: 'Tamanho', option_list: [{ option: 'M', image: null }] }],
      model_list: [
        {
          model_id: MODEL_A,
          model_sku: 'K-A',
          original_price: 99.9,
          tier_index: [0],
          component_list: [componente({})],
        },
      ],
    });

    await importarKitShopee(
      deps(db, { options: opcoes(), bucket: asBucket(bucket), fetchImpl: fetchDeFoto() }),
      entradaDeKit(detalhe),
    );

    expect(passos(db, [filhoId])).toEqual([
      'taxonomia',
      'categoria',
      'categoria',
      'categoria',
      'produto-pai',
      'extraData',
      'link-pai',
      'produto-filho0',
      'link-filho0',
      'filho-unico',
      'arquivo',
      'arquivo',
      'fotos-pai',
      // Step 19: ONE shared aviso decision for (conta, kit), AFTER the writer.
      // A first import has no row to pre-stamp, so nothing precedes taxonomia.
      'aviso',
    ]);
    expect(bucket.caminhos).toHaveLength(1);
    expect(db.store[`arquivos/${productArquivoId(PAI_ID, HASH_FOTO)}`]).toBeDefined();
  });

  it('um re-import byte-idêntico não cria NENHUM documento novo', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const entrada = entradaDeKit(kit());

    await importarKitShopee(deps(db), entrada);
    const documentos = Object.keys(db.store).sort();

    const res = await importarKitShopee(deps(db), entrada);

    expect(Object.keys(db.store).sort()).toEqual(documentos);
    expect(res.criado).toBe(false);
    expect(res.variacoes.criadas).toBe(0);
    // E a composição continua lá, re-carimbada e não apagada.
    expect(docDoProduto(db, PAI_ID).componentesKit).toEqual({
      'comp-a': { quantidade: 1, limitarEstoque: true, timestamp: AGORA },
    });
  });

  it('⛔ um re-import byte-idêntico numa HORA DIFERENTE não escreve produto nenhum', async () => {
    // ⚠️ O relógio do despacho é outro, e é só isso que muda. `componentesKit`
    // NÃO está em `PRODUTO_HISTORY_IGNORE_FIELDS`, então re-carimbar a composição
    // aqui arquivaria uma linha de `historicoDeModificacoes` — sem autor, porque
    // quem escreve é o Admin SDK — no pai E em cada filho, a cada passada, por
    // uma composição que ninguém tocou. E o braço de kit re-importa por projeto:
    // um catálogo novo recusa quase todo kit na primeira passada.
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const entrada = entradaDeKit(kit());
    const UMA_HORA_DEPOIS = AGORA + 3_600_000;

    await importarKitShopee(deps(db), entrada);
    const escritasDoPrimeiroPasse = db.writes.length;

    await importarKitShopee(deps(db, { nowMs: UMA_HORA_DEPOIS }), entrada);

    // ⚠️ NENHUM merge de produto com os três campos de kit — nem no pai, nem no
    // filho. (O patch guardado de `precos.<tabelaId>` continua saindo: ele é do
    // caminho de LISTAGEM e um re-import de anúncio comum faz o mesmo.)
    const novas = db.writes.slice(escritasDoPrimeiroPasse);
    expect(novas.filter((w) => 'componentesKit' in w.patch)).toEqual([]);
    expect(novas.filter((w) => 'ehKit' in w.patch)).toEqual([]);
    // E o carimbo guardado é o do primeiro passe, não o do segundo.
    expect(docDoProduto(db, PAI_ID).componentesKit).toEqual({
      'comp-a': { quantidade: 1, limitarEstoque: true, timestamp: AGORA },
    });
  });

  it('⛔ NEAR-MISS: uma composição que MUDOU volta a escrever, e com o carimbo NOVO', async () => {
    // A outra metade: carregar o carimbo adiante não pode virar "nunca mais
    // escreve". Uma quantidade diferente é uma mudança real de composição.
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const UMA_HORA_DEPOIS = AGORA + 3_600_000;

    await importarKitShopee(deps(db), entradaDeKit(kit()));
    const escritasDoPrimeiroPasse = db.writes.length;

    await importarKitShopee(
      deps(db, { nowMs: UMA_HORA_DEPOIS }),
      entradaDeKit(
        kit({
          model_list: [
            {
              model_id: MODEL_A,
              model_sku: 'KIT-001-A',
              original_price: 99.9,
              component_list: [componente({ quantity: 2 })],
            },
          ],
        }),
      ),
    );

    const novas = db.writes.slice(escritasDoPrimeiroPasse);
    expect(novas.filter((w) => 'componentesKit' in w.patch).length).toBeGreaterThan(0);
    expect(docDoProduto(db, PAI_ID).componentesKit).toEqual({
      'comp-a': { quantidade: 2, limitarEstoque: true, timestamp: UMA_HORA_DEPOIS },
    });
  });

  it('o resultado conta os componentes DISTINTOS e o que foi criado', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    semearComponentePorVariacao(db, 'comp-b', MODEL_COMPONENTE);
    const detalhe = kit({
      model_list: [
        { model_id: MODEL_A, model_sku: 'K-A', component_list: [componente({})] },
        {
          model_id: MODEL_B,
          model_sku: 'K-B',
          component_list: [
            componente({}),
            componente({ component_item_id: COMPONENTE_B, component_model_id: MODEL_COMPONENTE }),
          ],
        },
      ],
    });

    const res = await importarKitShopee(deps(db), entradaDeKit(detalhe));

    expect(res.produtoId).toBe(PAI_ID);
    expect(res.criado).toBe(true);
    expect(res.nome).toBe('Kit Camiseta + Boné');
    expect(res.variacoes).toEqual({ total: 2, criadas: 2, semLink: 0 });
    // TRÊS linhas de componente, DOIS produtos.
    expect(res.kit).toEqual({ componentes: 2, criado: true, avisos: [] });
  });
});

/* ------------------------ 6. a leitura da página do kit ------------------- */

describe('anuncioDerivadoDoKit', () => {
  it('lê as quatro grafias próprias da página do kit e mantém a tag kit', () => {
    const detalhe = kit({
      attributes: [{ attribute_id: 1, original_attribute_name: 'Cor' }],
      brand_info: { brand_id: 5, original_brand_name: 'Delfrance' },
      pre_order_info: { is_pre_order: true, days_to_ship: 7 },
      tier_variation_list: [{ name: 'Tamanho', option_list: [{ option: 'M', image: null }] }],
      image: { image_url_list: [URL_FOTO], image_id_list: ['img-1'] },
    });

    const anuncio = anuncioDerivadoDoKit(entradaDeKit(detalhe), detalhe);

    expect(anuncio.base.attribute_list).toHaveLength(1);
    expect(anuncio.base.brand?.brand_id).toBe(5);
    expect(anuncio.base.pre_order?.days_to_ship).toBe(7);
    expect(anuncio.models?.tier_variation?.[0]?.name).toBe('Tamanho');
    expect(anuncio.base.image?.image_url_list).toEqual([URL_FOTO]);
    expect(anuncio.base.has_model).toBe(true);
    // ⚠️ Continua sendo um kit: a recusa de ROTEAMENTO do importador de anúncio
    // tem de continuar valendo se este registro escapar deste módulo.
    expect(anuncio.base.tag?.kit).toBe(true);
  });

  it('⛔ FIXA `tag.kit: true` mesmo quando a base de quem chama diz false ou null', () => {
    // É desta tag que o construtor de vínculo carimba `kitNativo`. Copiar a
    // tag da base faria um chamador descuidado gravar `kitNativo: false` num
    // kit nativo — e os passos 12 e 13 sincronizariam estoque e preço dele.
    const detalhe = kit();
    for (const tag of [{ kit: false }, { kit: null }, null]) {
      const entrada: ItemLido = {
        ...entradaDeKit(detalhe),
        base: shopeeItemBaseInfoRowSchema.parse({ item_id: ITEM_ID, tag }),
      };
      expect(anuncioDerivadoDoKit(entrada, detalhe).base.tag?.kit).toBe(true);
    }
  });

  it('NEAR-MISS: fixar `kit` não apaga as OUTRAS chaves da tag', () => {
    const detalhe = kit();
    const entrada: ItemLido = {
      ...entradaDeKit(detalhe),
      base: shopeeItemBaseInfoRowSchema.parse({
        item_id: ITEM_ID,
        tag: { kit: false, chave_futura: 'x' },
      }),
    };

    expect(anuncioDerivadoDoKit(entrada, detalhe).base.tag).toMatchObject({
      kit: true,
      chave_futura: 'x',
    });
  });

  it('⛔ um tier cujo image vem como ARRAY não quebra a leitura', () => {
    const detalhe = kit({
      tier_variation_list: [
        {
          name: 'Tamanho',
          option_list: [{ option: 'M', image: [{ image_id: 'i-1', image_url: URL_FOTO }] }],
        },
      ],
    });

    const anuncio = anuncioDerivadoDoKit(entradaDeKit(detalhe), detalhe);

    // A página do kit tipa essa imagem como ARRAY e a do item como objeto.
    // Ninguém no passo 9 lê imagem de opção, então ela é DESCARTADA — nunca
    // convertida em uma forma que a Shopee não mandou.
    expect(anuncio.models?.tier_variation?.[0]?.option_list?.[0]?.option).toBe('M');
    expect(anuncio.models?.tier_variation?.[0]?.option_list?.[0]?.image).toBeNull();
  });
});

/* ------------- 7. passo 19 — o id de modelo OCULTO e o salto (W2a1) ------------- */

/**
 * Os papéis do kit (D1): componente A tem variações; componente B NÃO tem, e a
 * Shopee devolve para ele um `component_model_id` OCULTO — diferente de zero,
 * diferente do `item_id` e ausente do `get_model_list` (vazio) dele (sonda 1).
 */
const KIT_ITEM = 2500139870;
const COMP_A = 2500139871;
const COMP_A_MODELO = 2000458821;
const COMP_B = 2500139872;
const COMP_B_OCULTO = 2000458829;

/** B, um anúncio SEM variação importado pelo passo 9: invólucro + membro único. */
function semearBFamiliaDeUm(db: FakeDb, over: Record<string, unknown> = {}): void {
  db.seed('produtos/comp-b', {
    nome: 'Componente B',
    sku: 'COMP-B',
    paiId: null,
    filhoUnicoId: 'comp-b-membro',
    ...over,
  });
  db.seed('produtos/comp-b-membro', { nome: 'Componente B', sku: 'COMP-B-UN', paiId: 'comp-b' });
  db.seed(`produtos/comp-b/prodshopee/vinc-${String(COMP_B)}`, {
    item_id: COMP_B,
    contaProdutoShopeeOuterRef: REF_CONTA,
  });
}

/** A, um anúncio COM variação: o filho tem o `variashopee` do modelo do componente. */
function semearAComVariacao(db: FakeDb): void {
  db.seed('produtos/comp-a-pai', { nome: 'Componente A', sku: 'COMP-A', paiId: null });
  semearComponentePorVariacao(db, 'comp-a-filho', COMP_A_MODELO);
}

/** Um kit de UM modelo cujo único componente é B, na grafia medida (id OCULTO, sku vazio). */
function kitSoComB(): ShopeeKitItem {
  return kit({
    model_list: [
      {
        model_id: MODEL_A,
        model_sku: 'KIT-001-A',
        original_price: 99.9,
        component_list: [
          componente({
            component_item_id: COMP_B,
            component_model_id: COMP_B_OCULTO,
            component_item_or_model_sku: '',
          }),
        ],
      },
    ],
  });
}

describe('passo 19 — o id OCULTO de um componente sem variação (M42, M43)', () => {
  it('(M42) has_model false ⇒ o componente B liga pelo `prodshopee`, e o kit NÃO é recusado', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-b', COMP_B);
    const temModelos = new Map([[COMP_B, false]]);

    const [c] = await resolverComponentesDoKit(asDb(db), INTEGRACAO, kitSoComB(), temModelos);

    expect(c).toMatchObject({ produtoId: 'comp-b', via: 'prodshopee', modelIdDoComponente: 0 });

    await importarKitShopee(deps(db), {
      ...entradaDeKit(kitSoComB()),
      temModelosDosComponentes: temModelos,
    });
    expect(Object.keys(docDoProduto(db, PAI_ID).componentesKit as object)).toEqual(['comp-b']);
  });

  it('⛔ NEAR-MISS: sem o has_model (o caminho de hoje) o MESMO kit é recusado — o id oculto não liga', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-b', COMP_B);

    const erro = await importarKitShopee(deps(db), entradaDeKit(kitSoComB())).catch(
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(ShopeeImportBlockedError);
    expect((erro as ShopeeImportBlockedError).motivo).toBe('kit-componente-nao-vinculado');
    // O id oculto aparece VERBATIM: desconhecido nunca é dobrado.
    expect((erro as ShopeeImportBlockedError).mensagem).toContain(
      `modelo ${String(COMP_B_OCULTO)}`,
    );
  });

  it('(M43) ⛔ um item AUSENTE do mapa é desconhecido: o id oculto vai VERBATIM e cai nos degraus de SKU', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-b', COMP_B);
    // Só A está no mapa; B não veio na leitura de base.
    const temModelos = new Map([[COMP_A, true]]);

    const [c] = await resolverComponentesDoKit(asDb(db), INTEGRACAO, kitSoComB(), temModelos);

    // Lido como `false`, B ligaria o produto do vínculo de listagem sem prova.
    expect(c).toMatchObject({
      produtoId: null,
      via: 'unresolved',
      modelIdDoComponente: COMP_B_OCULTO,
    });
  });

  it('has_model true ⇒ o id é uma VARIAÇÃO e liga no `variashopee` do filho', async () => {
    const db = new FakeDb();
    semearAComVariacao(db);
    const detalhe = kit({
      model_list: [
        {
          model_id: MODEL_A,
          model_sku: 'KIT-001-A',
          component_list: [
            componente({ component_item_id: COMP_A, component_model_id: COMP_A_MODELO }),
          ],
        },
      ],
    });

    const [c] = await resolverComponentesDoKit(
      asDb(db),
      INTEGRACAO,
      detalhe,
      new Map([[COMP_A, true]]),
    );

    expect(c).toMatchObject({
      produtoId: 'comp-a-filho',
      via: 'variashopee',
      modelIdDoComponente: COMP_A_MODELO,
    });
  });
});

describe('passo 19 — o salto do `prodshopee` para a unidade vendável (M48)', () => {
  it('(M48) B é família de UM: a chave do mapa é o MEMBRO, nunca o invólucro', async () => {
    const db = new FakeDb();
    semearBFamiliaDeUm(db);
    const temModelos = new Map([[COMP_B, false]]);

    const [c] = await resolverComponentesDoKit(asDb(db), INTEGRACAO, kitSoComB(), temModelos);

    expect(c).toMatchObject({ produtoId: 'comp-b-membro', via: 'prodshopee' });

    await importarKitShopee(deps(db), {
      ...entradaDeKit(kitSoComB()),
      temModelosDosComponentes: temModelos,
    });
    const pai = docDoProduto(db, PAI_ID);
    expect(Object.keys(pai.componentesKit as object)).toEqual(['comp-b-membro']);
    expect(pai.componentesKitKeys).toEqual(['comp-b-membro']);
  });

  it('⛔ NEAR-MISS: um KIT de família de um fica no PAI (o espelho nunca é a resposta)', async () => {
    const db = new FakeDb();
    semearBFamiliaDeUm(db, { ehKit: true });

    const [c] = await resolverComponentesDoKit(
      asDb(db),
      INTEGRACAO,
      kitSoComB(),
      new Map([[COMP_B, false]]),
    );

    expect(c?.produtoId).toBe('comp-b');
  });

  it('⛔ NEAR-MISS: um dono que é FILHO (filhoUnicoId velho) responde ele mesmo — o guarda de deriva', async () => {
    const db = new FakeDb();
    db.seed('produtos/comp-b', {
      nome: 'B',
      sku: 'COMP-B',
      paiId: 'outro-pai',
      filhoUnicoId: 'resto-velho',
    });
    db.seed(`produtos/comp-b/prodshopee/vinc-${String(COMP_B)}`, {
      item_id: COMP_B,
      contaProdutoShopeeOuterRef: REF_CONTA,
    });

    const [c] = await resolverComponentesDoKit(
      asDb(db),
      INTEGRACAO,
      kitSoComB(),
      new Map([[COMP_B, false]]),
    );

    expect(c?.produtoId).toBe('comp-b');
  });

  it('um dono lido UMA vez, por mais modelos que o nomeiem', async () => {
    const db = new FakeDb();
    semearBFamiliaDeUm(db);
    const linhaB = componente({
      component_item_id: COMP_B,
      component_model_id: COMP_B_OCULTO,
      component_item_or_model_sku: '',
    });
    const detalhe = kit({
      model_list: [
        { model_id: MODEL_A, model_sku: 'K-A', component_list: [linhaB] },
        { model_id: MODEL_B, model_sku: 'K-B', component_list: [linhaB] },
      ],
    });

    const componentes = await resolverComponentesDoKit(
      asDb(db),
      INTEGRACAO,
      detalhe,
      new Map([[COMP_B, false]]),
    );

    expect(componentes.map((c) => c.produtoId)).toEqual(['comp-b-membro', 'comp-b-membro']);
    expect(db.opLog.filter((o) => o.op === 'get' && o.path === 'produtos/comp-b')).toHaveLength(1);
  });
});

describe('RT8 — o id oculto ATRAVÉS do import, sobre a captura real do kit', () => {
  /**
   * A captura do SG (`get_kit_item_info.sg-pos-criacao`, ids por papel): um
   * modelo, A ×2 no seu modelo e B ×1 com o id OCULTO e sku vazio. O
   * `get_item_base_info` dos COMPONENTES é sintético (só `has_model`): a
   * captura dele não é do corpus.
   */
  function clienteDoKit(temModeloB: boolean): {
    client: ShopeeClient;
    pedidosDeBase: number[][];
  } {
    const pedidosDeBase: number[][] = [];
    const baseDoKit = shopeeItemBaseInfoSchema.parse(
      lerFixture('get_item_base_info.sg-kit.json'),
    ).response;
    const paginaDoKit = shopeeKitItemInfoSchema.parse(
      lerFixture('get_kit_item_info.sg-pos-criacao.json'),
    ).response;
    const client = {
      getItemBaseInfo: (p: { itemIds: readonly number[] }) => {
        pedidosDeBase.push([...p.itemIds]);
        if (p.itemIds.includes(KIT_ITEM)) return Promise.resolve(baseDoKit);
        return Promise.resolve(
          shopeeItemBaseInfoPayloadSchema.parse({
            item_list: [
              { item_id: COMP_A, has_model: true },
              { item_id: COMP_B, has_model: temModeloB },
            ],
          }),
        );
      },
      getKitItemInfo: () => Promise.resolve(paginaDoKit),
    } as unknown as ShopeeClient;
    return { client, pedidosDeBase };
  }

  it('B (has_model false) liga pelo `prodshopee` e SALTA para o membro; A liga no `variashopee`', async () => {
    const db = new FakeDb();
    semearAComVariacao(db);
    semearBFamiliaDeUm(db);
    const { client, pedidosDeBase } = clienteDoKit(false);

    // O LEITOR real (lerAnuncio) → o IMPORTADOR real: nenhum ItemLido montado à mão.
    const entrada = await lerAnuncioShopee(client, KIT_ITEM);
    expect(pedidosDeBase).toEqual([[KIT_ITEM], [COMP_A, COMP_B]]);

    const preparo = await prepararImportacaoKitShopee(deps(db), entrada);
    expect(
      preparo.componentes.map((c) => [c.itemId, c.modelIdDoComponente, c.via, c.produtoId]),
    ).toEqual([
      [COMP_A, COMP_A_MODELO, 'variashopee', 'comp-a-filho'],
      [COMP_B, 0, 'prodshopee', 'comp-b-membro'],
    ]);

    await importarKitShopee(deps(db), entrada);
    const pai = docDoProduto(db, idDoPaiPlanejado(INTEGRACAO, KIT_ITEM));
    expect(pai.componentesKit).toMatchObject({
      'comp-a-filho': { quantidade: 2, limitarEstoque: true },
      'comp-b-membro': { quantidade: 1, limitarEstoque: true },
    });
    expect(pai.componentesKitKeys).toEqual(['comp-a-filho', 'comp-b-membro']);
  });

  it('⛔ o GÊMEO has_model true: o mesmo id oculto é tratado como variação — sem `variashopee` dele, o kit é recusado', async () => {
    // A mesma página, só o has_model de B virado: o id deixa de ser "oculto" e
    // passa a pedir o degrau da variação, que não existe; sem sku, nada liga.
    const db = new FakeDb();
    semearAComVariacao(db);
    semearBFamiliaDeUm(db);
    const { client } = clienteDoKit(true);

    const entrada = await lerAnuncioShopee(client, KIT_ITEM);
    const erro = await importarKitShopee(deps(db), entrada).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeImportBlockedError);
    expect((erro as ShopeeImportBlockedError).mensagem).toContain(
      `componente item ${String(COMP_B)}/modelo ${String(COMP_B_OCULTO)}`,
    );
  });

  it('o GÊMEO has_model true COM o seu `variashopee` liga no modelo, sem salto', async () => {
    const db = new FakeDb();
    semearAComVariacao(db);
    semearBFamiliaDeUm(db);
    semearComponentePorVariacao(db, 'comp-b-variacao', COMP_B_OCULTO);
    const { client } = clienteDoKit(true);

    const entrada = await lerAnuncioShopee(client, KIT_ITEM);
    const preparo = await prepararImportacaoKitShopee(deps(db), entrada);

    expect(preparo.componentes[1]).toMatchObject({
      itemId: COMP_B,
      modelIdDoComponente: COMP_B_OCULTO,
      via: 'variashopee',
      produtoId: 'comp-b-variacao',
    });
  });
});

/* ------------- passo 19 — R-t e R-u: o re-import e o kit nativo (W2a2) ------------- */

/** O modelo do kit (papel D1) e o modelo anexado/segundo kit (papéis da reconciliação). */
const KIT_MODELO = 2000458820;
const KIT_GEMEO = 2500139873;
/** O vínculo DETERMINÍSTICO que a criação e o import calculam para o kit 2500139870. */
const VINCULO_19 = idDoVinculoDeKit(INTEGRACAO, KIT_ITEM);
/** O pai que o PRIMEIRO import cunha para o kit 2500139870. */
const PAI_19 = idDoPaiPlanejado(INTEGRACAO, KIT_ITEM);

/** A impressão digital ERP de `{comp-a: q}` — o carimbo que uma linha conferida guarda. */
function digital(q: number, componente = 'comp-a'): string {
  return chaveReceitaKitErp({ [componente]: { quantidade: q } });
}

interface ModeloKit19 {
  readonly modelId: number;
  readonly sku: string | null;
  readonly quantidade: number;
  readonly opcao?: string;
}

/**
 * Um kit dos papéis do passo 19: cada modelo consome `quantidade` × o
 * componente A (um anúncio SEM variação, ligado pelo `prodshopee` de `comp-a`).
 * `tiers` ausente: 1 modelo ⇒ sem tier; N modelos ⇒ um tier `Cor`.
 */
function kit19(
  modelos: readonly ModeloKit19[],
  extra: { itemId?: number; tiers?: unknown } = {},
): ShopeeKitItem {
  const tiers =
    extra.tiers !== undefined
      ? extra.tiers
      : modelos.length > 1
        ? [
            {
              name: 'Cor',
              option_list: modelos.map((m) => ({ option: m.opcao ?? String(m.modelId) })),
            },
          ]
        : null;
  return shopeeKitItemSchema.parse({
    item_id: extra.itemId ?? KIT_ITEM,
    item_name: 'Kit Passo 19',
    item_sku: 'KIT-19',
    category_id: 100017,
    weight: '0.8',
    tier_variation_list: tiers,
    model_list: modelos.map((m, i) => ({
      model_id: m.modelId,
      model_sku: m.sku,
      original_price: 50,
      tier_index: tiers === null ? [] : [i],
      component_list: [
        { component_item_id: COMPONENTE_A, component_model_id: 0, quantity: m.quantidade },
      ],
    })),
  });
}

/** O `ItemLido` de um kit do passo 19 — base mínima com `tag.kit`, a página do kit. */
function entrada19(detalhe: ShopeeKitItem): ItemLido {
  return {
    base: shopeeItemBaseInfoRowSchema.parse({ item_id: detalhe.item_id, tag: { kit: true } }),
    models: null,
    taxInfo: null,
    kit: detalhe,
    itemId: detalhe.item_id,
  };
}

/** O tier do kit de UM modelo que a criação publica (`'Kit'`/`'Padrão'`, L10(1)). */
const TIER_SENTINELA = [{ name: 'Kit', option_list: [{ option: 'Padrão' }] }];

function linhaDoKit(
  db: FakeDb,
  filhoId: string,
  vinculo = VINCULO_19,
  modelId = KIT_MODELO,
): Record<string, unknown> | undefined {
  return db.store[`produtos/${filhoId}/variashopee/${idDaVariacaoDeKit(vinculo, modelId)}`]
    ?.data as Record<string, unknown> | undefined;
}

/**
 * O operador edita a receita (o trigger espelha o pai de uma família de um no
 * membro — aqui os DOIS documentos são reescritos, como ficariam).
 */
function editarReceita(db: FakeDb, ids: readonly string[], q: number, componente = 'comp-a'): void {
  for (const id of ids) {
    const atual = docDoProduto(db, id);
    db.seed(`produtos/${id}`, {
      ...atual,
      componentesKit: { [componente]: { quantidade: q, limitarEstoque: true, timestamp: null } },
      componentesKitKeys: [componente],
    });
  }
}

/** A decisão compartilhada, como o trigger a chamaria depois de um salvamento. */
function reavaliar(db: FakeDb, kitId = PAI_19): Promise<'aberto' | 'resolvido' | 'nada'> {
  return reavaliarAvisoDeReceitaKit(
    asDb(db),
    { integracaoId: INTEGRACAO, kitProdutoId: kitId },
    MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
    { agoraUs: 1, increment },
  );
}

function avisoDoKit(db: FakeDb, kitId = PAI_19): Record<string, unknown> | undefined {
  return db.store[avisoCollection.docPath({}, chaveAvisoReceitaKitShopee(INTEGRACAO, kitId))]
    ?.data as Record<string, unknown> | undefined;
}

/** Os produtos FILHOS de `paiId` hoje no banco. */
function filhosDe(db: FakeDb, paiId: string): string[] {
  return Object.entries(db.store)
    .filter(
      ([p, d]) => /^produtos\/[^/]+$/.test(p) && (d.data as { paiId?: unknown }).paiId === paiId,
    )
    .map(([p]) => p.slice('produtos/'.length))
    .sort();
}

describe('passo 19 — decidirReceitaDoFilho, a regra pura do R-t', () => {
  it('PAR IGUAL: o conteúdo decide primeiro — receitas iguais são `igual` MESMO com carimbos velhos', () => {
    expect(
      decidirReceitaDoFilho({
        chaveShopee: digital(2),
        chaveAtual: digital(2),
        carimbosContados: [digital(9), null],
      }),
    ).toBe('igual');
  });

  it('diferente e algum carimbo contado ≠ a impressão atual ⇒ `mantida` (null incluso)', () => {
    expect(
      decidirReceitaDoFilho({
        chaveShopee: digital(1),
        chaveAtual: digital(3),
        carimbosContados: [digital(3), null],
      }),
    ).toBe('mantida');
  });

  it('⛔ NEAR-MISS: um carimbo igual à receita da SHOPEE (não à atual) ainda é edição pendente', () => {
    expect(
      decidirReceitaDoFilho({
        chaveShopee: digital(1),
        chaveAtual: digital(3),
        carimbosContados: [digital(1)],
      }),
    ).toBe('mantida');
  });

  it('diferente e TODO carimbo contado é a impressão atual (ou nenhum) ⇒ a Shopee vence', () => {
    expect(
      decidirReceitaDoFilho({
        chaveShopee: digital(1),
        chaveAtual: digital(3),
        carimbosContados: [digital(3), digital(3)],
      }),
    ).toBe('shopee');
    expect(
      decidirReceitaDoFilho({
        chaveShopee: digital(1),
        chaveAtual: digital(3),
        carimbosContados: [],
      }),
    ).toBe('shopee');
  });

  it('(R1-RT7-01) K ≠ membro: a Shopee igual a K é `igual`; qualquer outra é `mantida` — os carimbos não salvam', () => {
    // K editado para 3, o membro (espelho pendente) em 2, todas as linhas conferidas em 2.
    const base = { chaveAtual: digital(2), carimbosContados: [digital(2)], chaveDoPai: digital(3) };
    expect(decidirReceitaDoFilho({ ...base, chaveShopee: digital(3) })).toBe('igual');
    expect(decidirReceitaDoFilho({ ...base, chaveShopee: digital(2) })).toBe('mantida');
    expect(decidirReceitaDoFilho({ ...base, chaveShopee: digital(5) })).toBe('mantida');
  });

  it('⛔ NEAR-MISS (R1-RT7-01): K IGUAL ao membro, ou ausente, deixa a regra de sempre decidir', () => {
    const base = { chaveAtual: digital(2), carimbosContados: [digital(2)] };
    for (const chaveDoPai of [digital(2), null, undefined]) {
      expect(decidirReceitaDoFilho({ ...base, chaveDoPai, chaveShopee: digital(2) })).toBe('igual');
      expect(decidirReceitaDoFilho({ ...base, chaveDoPai, chaveShopee: digital(5) })).toBe(
        'shopee',
      );
    }
  });
});

describe('passo 19 — chaveDoPaiDaFamiliaDeUm (R1-RT7-01)', () => {
  const k = (parcial: Record<string, unknown>): Record<string, unknown> => ({
    filhoUnicoId: 'membro',
    componentesKit: { 'comp-a': { quantidade: 3, limitarEstoque: true, timestamp: null } },
    ...parcial,
  });

  it('um modelo, K nomeia o filho e tem mapa ⇒ a impressão do mapa de K', () => {
    expect(chaveDoPaiDaFamiliaDeUm(k({}), 'membro', 1)).toBe(digital(3));
  });

  it('⛔ NEAR-MISS: 2 modelos, outro filho, K sem mapa (null ou ausente) ou K ausente ⇒ null', () => {
    expect(chaveDoPaiDaFamiliaDeUm(k({}), 'membro', 2)).toBeNull();
    expect(chaveDoPaiDaFamiliaDeUm(k({}), 'outro', 1)).toBeNull();
    expect(chaveDoPaiDaFamiliaDeUm(k({ filhoUnicoId: null }), 'membro', 1)).toBeNull();
    expect(chaveDoPaiDaFamiliaDeUm(k({ componentesKit: null }), 'membro', 1)).toBeNull();
    expect(chaveDoPaiDaFamiliaDeUm({ filhoUnicoId: 'membro' }, 'membro', 1)).toBeNull();
    expect(chaveDoPaiDaFamiliaDeUm(null, 'membro', 1)).toBeNull();
  });
});

describe('passo 19 — receitaFielAosEnderecos (R2-F2)', () => {
  const c = (
    itemId: number,
    modelIdDoComponente: number,
    produtoId: string | null,
    quantidade = 1,
  ): ComponenteDoKitShopee => ({
    modelId: 2000458820,
    itemId,
    modelIdDoComponente,
    sku: null,
    quantidade,
    produtoId,
    via: 'prodshopee' as ComponenteDoKitShopee['via'],
  });

  it('PAR IGUAL: um endereço por produto — e o MESMO endereço em duas linhas (a dobra soma) — é fiel', () => {
    expect(receitaFielAosEnderecos([c(1, 0, 'p'), c(2, 0, 'q')])).toBe(true);
    expect(receitaFielAosEnderecos([c(1, 0, 'p', 2), c(1, 0, 'p', 3)])).toBe(true);
    expect(receitaFielAosEnderecos([])).toBe(true);
  });

  it('⛔ NEAR-MISS: dois endereços DISTINTOS no mesmo produto — outro item, ou outro modelo do mesmo item — não é fiel', () => {
    expect(receitaFielAosEnderecos([c(1, 0, 'p', 2), c(2, 0, 'p', 3)])).toBe(false);
    expect(receitaFielAosEnderecos([c(1, 11, 'p'), c(1, 12, 'p')])).toBe(false);
    // Um componente SEM produto não conta (o kit é recusado antes, de todo modo).
    expect(receitaFielAosEnderecos([c(1, 0, null), c(2, 0, null)])).toBe(true);
  });
});

describe('passo 19 — ehTierDeKitUnico, o ponto fixo da família de um (R-8)', () => {
  const um = (tiers: unknown): ShopeeKitItem =>
    kit19([{ modelId: KIT_MODELO, sku: null, quantidade: 1 }], { tiers });

  it('exatamente `Kit`/`Padrão` num kit de UM modelo ⇒ sem tier', () => {
    expect(ehTierDeKitUnico(um(TIER_SENTINELA))).toBe(true);
    expect(
      anuncioDerivadoDoKit(entrada19(um(TIER_SENTINELA)), um(TIER_SENTINELA)).models
        ?.tier_variation,
    ).toEqual([]);
  });

  it('⛔ NEAR-MISS: grafia, segunda opção, segundo tier ou segundo modelo são um tier REAL', () => {
    expect(ehTierDeKitUnico(um([{ name: 'kit', option_list: [{ option: 'Padrão' }] }]))).toBe(
      false,
    );
    expect(ehTierDeKitUnico(um([{ name: 'Kit', option_list: [{ option: 'Padrao' }] }]))).toBe(
      false,
    );
    expect(
      ehTierDeKitUnico(
        um([{ name: 'Kit', option_list: [{ option: 'Padrão' }, { option: 'Outro' }] }]),
      ),
    ).toBe(false);
    expect(ehTierDeKitUnico(um([...TIER_SENTINELA, { name: 'Cor', option_list: [] }]))).toBe(false);
    expect(
      ehTierDeKitUnico(
        kit19(
          [
            { modelId: KIT_MODELO, sku: null, quantidade: 1 },
            { modelId: MODEL_A, sku: null, quantidade: 1 },
          ],
          { tiers: TIER_SENTINELA },
        ),
      ),
    ).toBe(false);
    // ÂNCORA: o tier real chega à listagem derivada.
    const real = um([{ name: 'Kit', option_list: [{ option: 'Padrao' }] }]);
    expect(anuncioDerivadoDoKit(entrada19(real), real).models?.tier_variation).toHaveLength(1);
  });
});

describe('passo 19 — R-u: o vínculo DETERMINÍSTICO e a família de um (M50, M52)', () => {
  it('idDoVinculoDaListagemDeKit: o acerto do degrau 1 vence; sem ele, o id derivado', () => {
    expect(idDoVinculoDaListagemDeKit(INTEGRACAO, KIT_ITEM, 'auto-7')).toBe('auto-7');
    expect(idDoVinculoDaListagemDeKit(INTEGRACAO, KIT_ITEM, null)).toBe(VINCULO_19);
  });

  /** K já é família de um: `filhoUnicoId` = `membro`, que carrega uma linha de OUTRA listagem. */
  function semearFamiliaDeUm(db: FakeDb): void {
    db.seed(`produtos/${'kit-k'}`, {
      nome: 'Kit',
      sku: 'KIT-19',
      paiId: null,
      ehKit: true,
      filhoUnicoId: 'membro',
    });
    db.seed('produtos/membro', {
      nome: 'Kit membro',
      sku: 'MEMBRO-SKU',
      paiId: 'kit-k',
      ehKit: true,
    });
    db.seed('produtos/membro/variashopee/linha-comum', {
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: 'documents/produtos/kit-k/prodshopee/vinculo-comum',
      model_id: MODEL_A,
      tier_index: [],
    });
  }

  it('(M50) um kit de 1 modelo sobre uma família de um liga o MEMBRO — nenhum filho cunhado, nem com a linha de outra listagem', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    semearFamiliaDeUm(db);
    const linhaComum = structuredClone(db.store['produtos/membro/variashopee/linha-comum']?.data);
    // Um kit do Seller Centre: SEM model_sku, com o tier sentinela.
    const detalhe = kit19([{ modelId: KIT_MODELO, sku: null, quantidade: 2 }], {
      tiers: TIER_SENTINELA,
    });

    await importarKitShopee(deps(db), entrada19(detalhe));

    expect(filhosDe(db, 'kit-k')).toEqual(['membro']);
    expect(docDoProduto(db, 'kit-k').filhoUnicoId).toBe('membro');
    const vinculo = idDoVinculoDeKit(INTEGRACAO, KIT_ITEM);
    expect(linhaDoKit(db, 'membro', vinculo)?.model_id).toBe(KIT_MODELO);
    expect(docDoProduto(db, 'membro').componentesKit).toEqual({
      'comp-a': { quantidade: 2, limitarEstoque: true, timestamp: AGORA },
    });
    // A linha da OUTRA listagem: byte a byte a mesma.
    expect(db.store['produtos/membro/variashopee/linha-comum']?.data).toEqual(linhaComum);
  });

  it('(M52) o re-import de uma família de um com o tier sentinela não planeja taxonomia nem toca a variação do membro', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    semearFamiliaDeUm(db);
    const detalhe = kit19([{ modelId: KIT_MODELO, sku: null, quantidade: 2 }], {
      tiers: TIER_SENTINELA,
    });

    await importarKitShopee(deps(db), entrada19(detalhe));
    await importarKitShopee(deps(db, { nowMs: AGORA + 1 }), entrada19(detalhe));

    expect(db.writes.filter((w) => w.path.startsWith('grupoDeVariacoes/'))).toEqual([]);
    const membro = docDoProduto(db, 'membro');
    expect(membro.variacoesUid ?? null).toBeNull();
    expect(membro.grupoDeVariacoesUid ?? null).toBeNull();
  });

  it('⛔ NEAR-MISS: um ponteiro VELHO (o membro já é de outra família) nunca liga — o filho é cunhado', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    semearFamiliaDeUm(db);
    db.seed('produtos/membro', { nome: 'Kit membro', sku: 'MEMBRO-SKU', paiId: 'outro-pai' });
    const detalhe = kit19([{ modelId: KIT_MODELO, sku: null, quantidade: 2 }], {
      tiers: TIER_SENTINELA,
    });

    await importarKitShopee(deps(db), entrada19(detalhe));

    expect(filhosDe(db, 'kit-k')).toEqual([idDoFilhoPlanejado('kit-k', KIT_MODELO)]);
    expect(linhaDoKit(db, 'membro')).toBeUndefined();
  });

  it('(S2C-01) o kit NOVO de uma família cujos filhos carregam as linhas do kit ANTIGO liga cada filho pelo SKU — nenhum cunhado, as linhas antigas intactas', async () => {
    // O cenário da recuperação L9 de um recriar/converter: K já tem um kit vivo
    // (VINCULO_19) e os filhos carregam as linhas DELE; um segundo kit de mesmo
    // SKU (o novo, criado e não vinculado) é importado. Sem o escopo da
    // listagem, cada filho pareceria "reivindicado" pelo `model_id` antigo e o
    // degrau 4 cunharia duplicatas.
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const antigo: readonly ModeloKit19[] = [
      { modelId: KIT_MODELO, sku: 'K19-A', quantidade: 1, opcao: 'Azul' },
      { modelId: MODEL_A, sku: 'K19-B', quantidade: 2, opcao: 'Verde' },
    ];
    await importarKitShopee(deps(db), entrada19(kit19(antigo)));
    const fa = idDoFilhoPlanejado(PAI_19, KIT_MODELO);
    const fb = idDoFilhoPlanejado(PAI_19, MODEL_A);
    const linhaAntigaA = structuredClone(linhaDoKit(db, fa));
    const linhaAntigaB = structuredClone(linhaDoKit(db, fb, VINCULO_19, MODEL_A));
    expect(linhaAntigaA?.model_id).toBe(KIT_MODELO);

    const MODELO_NOVO_A = 2000458822;
    const MODELO_NOVO_B = 2000458823;
    const novo = kit19(
      [
        { modelId: MODELO_NOVO_A, sku: 'K19-A', quantidade: 1, opcao: 'Azul' },
        { modelId: MODELO_NOVO_B, sku: 'K19-B', quantidade: 2, opcao: 'Verde' },
      ],
      { itemId: KIT_GEMEO },
    );
    const res = await importarKitShopee(deps(db, { nowMs: AGORA + 1 }), entrada19(novo));

    expect(res.produtoId).toBe(PAI_19);
    expect(filhosDe(db, PAI_19)).toEqual([fa, fb].sort());
    const vinculoNovo = idDoVinculoDeKit(INTEGRACAO, KIT_GEMEO);
    expect(linhaDoKit(db, fa, vinculoNovo, MODELO_NOVO_A)?.model_id).toBe(MODELO_NOVO_A);
    expect(linhaDoKit(db, fb, vinculoNovo, MODELO_NOVO_B)?.model_id).toBe(MODELO_NOVO_B);
    // As linhas do kit ANTIGO: byte a byte as mesmas — nem reivindicaram o
    // filho, nem foram reusadas como o vínculo do novo.
    expect(linhaDoKit(db, fa)).toEqual(linhaAntigaA);
    expect(linhaDoKit(db, fb, VINCULO_19, MODEL_A)).toEqual(linhaAntigaB);
  });
});

describe('passo 19 — R-t: um re-import nunca reverte em silêncio uma edição pendente (M45, M49, M51, M59, M62, M63)', () => {
  const FAMILIA: readonly ModeloKit19[] = [
    { modelId: KIT_MODELO, sku: 'K19-A', quantidade: 1, opcao: 'Azul' },
    { modelId: MODEL_A, sku: 'K19-B', quantidade: 2, opcao: 'Verde' },
  ];

  it('(M49) aviso aberto + re-import ⇒ o mapa do ERP fica, o aviso continua ABERTO e o import diz `receita-divergente`', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const fa = idDoFilhoPlanejado(PAI_19, KIT_MODELO);
    const fb = idDoFilhoPlanejado(PAI_19, MODEL_A);
    await importarKitShopee(deps(db), entrada19(kit19(FAMILIA)));
    expect(linhaDoKit(db, fa)?.receitaKitConferida).toBe(digital(1));

    // O operador muda A de 1 para 3; a decisão do trigger abre o aviso.
    editarReceita(db, [fa], 3);
    expect(await reavaliar(db)).toBe('aberto');
    const antes = db.writes.length;

    const res = await importarKitShopee(deps(db, { nowMs: AGORA + 1 }), entrada19(kit19(FAMILIA)));

    const novas = db.writes.slice(antes);
    expect(docDoProduto(db, fa).componentesKit).toEqual({
      'comp-a': { quantidade: 3, limitarEstoque: true, timestamp: null },
    });
    expect(novas.filter((w) => w.path === `produtos/${fa}` && 'componentesKit' in w.patch)).toEqual(
      [],
    );
    // Nenhum carimbo se moveu na linha de A — nem o pré-carimbo, nem o merge.
    expect(linhaDoKit(db, fa)?.receitaKitConferida).toBe(digital(1));
    expect(
      novas.filter((w) => w.path.startsWith(`produtos/${fa}/`) && 'receitaKitConferida' in w.patch),
    ).toEqual([]);
    expect(avisoDoKit(db)?.resolvidoEm).toBeNull();
    expect(res.kit.avisos).toEqual([
      {
        codigo: 'receita-divergente',
        produtoId: fa,
        mensagem: expect.stringContaining(fa),
      },
    ]);
    // ⛔ NEAR-MISS no MESMO import: B, sem edição, segue conferido.
    expect(linhaDoKit(db, fb, VINCULO_19, MODEL_A)?.receitaKitConferida).toBe(digital(2));
  });

  it('(M49, família de um) o filho mantido é o `filhoUnicoId` ⇒ o PAI não recebe receita nenhuma (sem espelho)', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const um = kit19([{ modelId: KIT_MODELO, sku: 'K19-UN', quantidade: 1 }], {
      tiers: TIER_SENTINELA,
    });
    await importarKitShopee(deps(db), entrada19(um));
    const membro = String(docDoProduto(db, PAI_19).filhoUnicoId);
    expect(membro).toBe(idDoFilhoPlanejado(PAI_19, KIT_MODELO));

    editarReceita(db, [PAI_19, membro], 3);
    expect(await reavaliar(db)).toBe('aberto');
    const antes = db.writes.length;

    const res = await importarKitShopee(deps(db, { nowMs: AGORA + 1 }), entrada19(um));

    const escritasDoPai = db.writes.slice(antes).filter((w) => w.path === `produtos/${PAI_19}`);
    expect(
      escritasDoPai.filter((w) => 'componentesKit' in w.patch || 'componentesKitKeys' in w.patch),
    ).toEqual([]);
    expect(docDoProduto(db, PAI_19).componentesKit).toEqual({
      'comp-a': { quantidade: 3, limitarEstoque: true, timestamp: null },
    });
    expect(res.kit.avisos.map((a) => a.produtoId)).toEqual([membro]);
    expect(avisoDoKit(db)?.resolvidoEm).toBeNull();
  });

  /**
   * R1-RT7-01 — a família de um whose WRAPPER holds an edit the member has not
   * received yet (the sole-member mirror is a later trigger that never retries):
   * the verifier's scratch repro, kept as a near-miss of the test above, where K
   * and the member were edited TOGETHER.
   */
  describe('(R1-RT7-01) o espelho da família de um ainda PENDENTE', () => {
    async function familiaDeUmConferida(q: number): Promise<{ db: FakeDb; membro: string }> {
      const db = new FakeDb();
      semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
      await importarKitShopee(
        deps(db),
        entrada19(
          kit19([{ modelId: KIT_MODELO, sku: 'K19-UN', quantidade: q }], {
            tiers: TIER_SENTINELA,
          }),
        ),
      );
      const membro = String(docDoProduto(db, PAI_19).filhoUnicoId);
      expect(membro).toBe(idDoFilhoPlanejado(PAI_19, KIT_MODELO));
      expect(linhaDoKit(db, membro)?.receitaKitConferida).toBe(digital(q));
      return { db, membro };
    }

    it('só K editado (3×A), a Shopee e o membro em 2×A ⇒ K NÃO é revertido, nada é carimbado e o import diz `receita-divergente`', async () => {
      const { db, membro } = await familiaDeUmConferida(2);
      editarReceita(db, [PAI_19], 3);
      // O espelho ainda não rodou: o aviso não enxerga a edição (K não tem linha).
      expect(await reavaliar(db)).not.toBe('aberto');
      const antes = db.writes.length;

      const res = await importarKitShopee(
        deps(db, { nowMs: AGORA + 1 }),
        entrada19(
          kit19([{ modelId: KIT_MODELO, sku: 'K19-UN', quantidade: 2 }], {
            tiers: TIER_SENTINELA,
          }),
        ),
      );

      const novas = db.writes.slice(antes);
      expect(docDoProduto(db, PAI_19).componentesKit).toEqual({
        'comp-a': { quantidade: 3, limitarEstoque: true, timestamp: null },
      });
      expect(
        novas.filter(
          (w) =>
            (w.path === `produtos/${PAI_19}` || w.path === `produtos/${membro}`) &&
            ('componentesKit' in w.patch || 'componentesKitKeys' in w.patch),
        ),
      ).toEqual([]);
      expect(novas.filter((w) => 'receitaKitConferida' in w.patch)).toEqual([]);
      expect(linhaDoKit(db, membro)?.receitaKitConferida).toBe(digital(2));
      expect(res.kit.avisos).toEqual([
        {
          codigo: 'receita-divergente',
          produtoId: membro,
          mensagem: expect.stringContaining(membro),
        },
      ]);
    });

    it('⛔ NEAR-MISS: só K editado (3×A) e a Shopee JÁ em 3×A ⇒ `igual` — o import completa o espelho e carimba 3', async () => {
      const { db, membro } = await familiaDeUmConferida(2);
      editarReceita(db, [PAI_19], 3);

      const res = await importarKitShopee(
        deps(db, { nowMs: AGORA + 1 }),
        entrada19(
          kit19([{ modelId: KIT_MODELO, sku: 'K19-UN', quantidade: 3 }], {
            tiers: TIER_SENTINELA,
          }),
        ),
      );

      expect(res.kit.avisos).toEqual([]);
      expect(docDoProduto(db, membro).componentesKit).toMatchObject({
        'comp-a': { quantidade: 3 },
      });
      expect(docDoProduto(db, PAI_19).componentesKit).toMatchObject({
        'comp-a': { quantidade: 3 },
      });
      expect(linhaDoKit(db, membro)?.receitaKitConferida).toBe(digital(3));
    });

    it('⛔ NEAR-MISS: K e o membro IGUAIS (espelho em dia) ⇒ a regra de sempre — a Shopee vence sem nada pendente', async () => {
      const { db, membro } = await familiaDeUmConferida(2);

      const res = await importarKitShopee(
        deps(db, { nowMs: AGORA + 1 }),
        entrada19(
          kit19([{ modelId: KIT_MODELO, sku: 'K19-UN', quantidade: 4 }], {
            tiers: TIER_SENTINELA,
          }),
        ),
      );

      expect(res.kit.avisos).toEqual([]);
      expect(docDoProduto(db, PAI_19).componentesKit).toMatchObject({
        'comp-a': { quantidade: 4 },
      });
      expect(linhaDoKit(db, membro)?.receitaKitConferida).toBe(digital(4));
    });
  });

  it('(M45, M49) sem edição pendente e a Shopee DIFERENTE: o pré-carimbo vem ANTES do filho e do PAI', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const umDe = (q: number): ShopeeKitItem =>
      kit19([{ modelId: KIT_MODELO, sku: 'K19-UN', quantidade: q }], { tiers: TIER_SENTINELA });
    await importarKitShopee(deps(db), entrada19(umDe(1)));
    const membro = idDoFilhoPlanejado(PAI_19, KIT_MODELO);
    const caminhoDaLinha = `produtos/${membro}/variashopee/${idDaVariacaoDeKit(VINCULO_19, KIT_MODELO)}`;
    const antes = db.writes.length;

    const res = await importarKitShopee(deps(db, { nowMs: AGORA + 1 }), entrada19(umDe(4)));

    const novas = db.writes.slice(antes);
    const preCarimbo = novas.findIndex(
      (w) => w.path === caminhoDaLinha && Object.keys(w.patch).join() === 'receitaKitConferida',
    );
    const pai = novas.findIndex((w) => w.path === `produtos/${PAI_19}`);
    const filho = novas.findIndex((w) => w.path === `produtos/${membro}`);
    expect(preCarimbo).toBeGreaterThanOrEqual(0);
    expect(pai).toBeGreaterThan(preCarimbo);
    expect(filho).toBeGreaterThan(preCarimbo);
    expect(novas[preCarimbo]?.patch).toEqual({ receitaKitConferida: digital(4) });
    // A Shopee venceu (nada pendente) e o aviso fecha como `importado`.
    expect(docDoProduto(db, membro).componentesKit).toMatchObject({ 'comp-a': { quantidade: 4 } });
    expect(linhaDoKit(db, membro)?.receitaKitConferida).toBe(digital(4));
    expect(res.kit.avisos).toEqual([]);
    expect(avisoDoKit(db)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_RECEITA_KIT.importado,
    });
    expect(avisoDoKit(db)?.resolvidoEm).not.toBeNull();
  });

  it('(M59) decide pelo CONTEÚDO: um repoint #1450 abriu o aviso, e o re-import que já lê o membro pré-carimba e fecha `importado`', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const um = kit19([{ modelId: KIT_MODELO, sku: 'K19-UN', quantidade: 2 }], {
      tiers: TIER_SENTINELA,
    });
    await importarKitShopee(deps(db), entrada19(um));
    const membro = idDoFilhoPlanejado(PAI_19, KIT_MODELO);

    // `comp-a` vira família de um (#1398) e o #1450 reaponta os mapas para o membro.
    db.seed('produtos/comp-a-membro', { nome: 'membro de A', sku: 'A-UN', paiId: 'comp-a' });
    db.seed('produtos/comp-a', {
      ...docDoProduto(db, 'comp-a'),
      filhoUnicoId: 'comp-a-membro',
    });
    editarReceita(db, [PAI_19, membro], 2, 'comp-a-membro');
    expect(await reavaliar(db)).toBe('aberto');

    const res = await importarKitShopee(deps(db, { nowMs: AGORA + 1 }), entrada19(um));

    expect(res.kit.avisos).toEqual([]);
    expect(linhaDoKit(db, membro)?.receitaKitConferida).toBe(digital(2, 'comp-a-membro'));
    expect(avisoDoKit(db)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_RECEITA_KIT.importado,
    });
    expect(avisoDoKit(db)?.resolvidoEm).not.toBeNull();
  });

  it('(M62) conta as linhas de TODO kit nativo ativo: a edição rastreada no kit vivo + o import de um GÊMEO de mesmo SKU ⇒ mapa mantido', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const um = kit19([{ modelId: KIT_MODELO, sku: 'K19-UN', quantidade: 1 }]);
    await importarKitShopee(deps(db), entrada19(um));
    const membro = idDoFilhoPlanejado(PAI_19, KIT_MODELO);
    editarReceita(db, [PAI_19, membro], 3);
    expect(await reavaliar(db)).toBe('aberto');

    // O gêmeo do Seller Centre: mesmo SKU, mesma receita VELHA, sem linha ainda.
    const gemeo = kit19([{ modelId: MODEL_A, sku: 'K19-UN', quantidade: 1 }], {
      itemId: KIT_GEMEO,
    });
    const res = await importarKitShopee(deps(db, { nowMs: AGORA + 1 }), entrada19(gemeo));

    expect(res.produtoId).toBe(PAI_19);
    expect(filhosDe(db, PAI_19)).toEqual([membro]);
    expect(docDoProduto(db, membro).componentesKit).toMatchObject({ 'comp-a': { quantidade: 3 } });
    expect(res.kit.avisos.map((a) => a.produtoId)).toEqual([membro]);
    // A linha NOVA do gêmeo nasce sem carimbo.
    const vinculoGemeo = idDoVinculoDeKit(INTEGRACAO, KIT_GEMEO);
    expect(linhaDoKit(db, membro, vinculoGemeo, MODEL_A)?.receitaKitConferida).toBeNull();
    expect(avisoDoKit(db)?.resolvidoEm).toBeNull();
  });

  it('(M62) o kit NOVO de uma recriação interrompida, igual ao ERP atual, é pré-carimbado enquanto o aviso segue aberto no antigo', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    await importarKitShopee(
      deps(db),
      entrada19(kit19([{ modelId: KIT_MODELO, sku: 'K19-UN', quantidade: 1 }])),
    );
    const membro = idDoFilhoPlanejado(PAI_19, KIT_MODELO);
    editarReceita(db, [PAI_19, membro], 3);
    expect(await reavaliar(db)).toBe('aberto');

    // O kit novo foi criado COM a receita atual do ERP (3) e não chegou a ser vinculado.
    const novo = kit19([{ modelId: MODEL_A, sku: 'K19-UN', quantidade: 3 }], { itemId: KIT_GEMEO });
    const res = await importarKitShopee(deps(db, { nowMs: AGORA + 1 }), entrada19(novo));

    expect(res.kit.avisos).toEqual([]);
    const vinculoNovo = idDoVinculoDeKit(INTEGRACAO, KIT_GEMEO);
    expect(linhaDoKit(db, membro, vinculoNovo, MODEL_A)?.receitaKitConferida).toBe(digital(3));
    // A linha do kit ANTIGO segue velha, e é ela que mantém o aviso aberto.
    expect(linhaDoKit(db, membro)?.receitaKitConferida).toBe(digital(1));
    expect(avisoDoKit(db)?.resolvidoEm).toBeNull();
  });

  for (const [nome, marca] of [
    ['substituído', { substituidoPorLinkDocId: 'vinculo-novo', substituidoEm: 1 }],
    ['removido', { estadoAnuncio: 'removido' }],
  ] as const) {
    it(`(M63) re-importar um kit ${nome} não escreve receita nem carimbo, e não abre aviso`, async () => {
      const db = new FakeDb();
      semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
      const deQ = (q: number): ShopeeKitItem =>
        kit19([{ modelId: KIT_MODELO, sku: 'K19-UN', quantidade: q }]);
      await importarKitShopee(deps(db), entrada19(deQ(1)));
      const membro = idDoFilhoPlanejado(PAI_19, KIT_MODELO);
      const caminhoDoVinculo = `produtos/${PAI_19}/prodshopee/${VINCULO_19}`;
      db.seed(caminhoDoVinculo, { ...(db.store[caminhoDoVinculo]?.data ?? {}), ...marca });
      const antes = db.writes.length;

      const res = await importarKitShopee(deps(db, { nowMs: AGORA + 1 }), entrada19(deQ(5)));

      const novas = db.writes.slice(antes);
      expect(
        novas.filter((w) => 'componentesKit' in w.patch || 'componentesKitKeys' in w.patch),
      ).toEqual([]);
      expect(novas.filter((w) => 'receitaKitConferida' in w.patch)).toEqual([]);
      expect(docDoProduto(db, membro).componentesKit).toMatchObject({
        'comp-a': { quantidade: 1 },
      });
      expect(docDoProduto(db, PAI_19).componentesKit).toMatchObject({
        'comp-a': { quantidade: 1 },
      });
      expect(linhaDoKit(db, membro)?.receitaKitConferida).toBe(digital(1));
      expect(res.kit.avisos).toEqual([]);
      // ÂNCORA: o vínculo foi de fato re-gravado (status), e o aviso não abriu.
      expect(novas.some((w) => w.path === caminhoDoVinculo)).toBe(true);
      expect(avisoDoKit(db)?.resolvidoEm).not.toBeNull();
    });
  }

  it('(M51) o import NUNCA grava `ehKitVirtual` — a decisão de publicar como kit nativo é do operador (O-7)', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    await importarKitShopee(deps(db), entrada19(kit19(FAMILIA)));
    await importarKitShopee(deps(db, { nowMs: AGORA + 1 }), entrada19(kit19(FAMILIA)));

    expect(db.writes.filter((w) => w.patch.ehKitVirtual === true)).toEqual([]);
    for (const id of [PAI_19, ...filhosDe(db, PAI_19)]) {
      expect(docDoProduto(db, id).ehKitVirtual ?? null, id).not.toBe(true);
    }
    // ÂNCORA: são kits de fato.
    expect(docDoProduto(db, PAI_19).ehKit).toBe(true);
  });

  it('(M46) o import reavalia o aviso UMA vez por (conta, kit), com o motivo `importado`', async () => {
    const db = new FakeDb();
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    const caminho = avisoCollection.docPath({}, chaveAvisoReceitaKitShopee(INTEGRACAO, PAI_19));

    await importarKitShopee(deps(db), entrada19(kit19(FAMILIA)));

    expect(db.writes.filter((w) => w.path === caminho)).toHaveLength(1);
    expect(avisoDoKit(db)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_RECEITA_KIT.importado,
    });
  });
});

describe('passo 19 — R2-F2: um carimbo só para uma receita FIEL aos endereços', () => {
  /** Um kit de UM modelo (tier sentinela) com as linhas dadas, todas com model 0. */
  function kitDeLinhas(linhas: readonly { item: number; q: number }[]): ShopeeKitItem {
    return shopeeKitItemSchema.parse({
      item_id: KIT_ITEM,
      item_name: 'Kit Passo 19',
      item_sku: 'KIT-19',
      category_id: 100017,
      weight: '0.8',
      tier_variation_list: TIER_SENTINELA,
      model_list: [
        {
          model_id: KIT_MODELO,
          model_sku: 'K19-UN',
          original_price: 50,
          tier_index: [0],
          component_list: linhas.map((l) => ({
            component_item_id: l.item,
            component_model_id: 0,
            quantity: l.q,
          })),
        },
      ],
    });
  }

  /** `comp-a` vendido em DUAS listagens (A e B) — a duplicata que `escolherLink` já prevê. */
  function semearDuasListagensDeA(db: FakeDb): void {
    semearComponentePorListagem(db, 'comp-a', COMPONENTE_A);
    db.seed(`produtos/comp-a/prodshopee/vinc-${String(COMPONENTE_B)}`, {
      item_id: COMPONENTE_B,
      contaProdutoShopeeOuterRef: REF_CONTA,
    });
  }

  it('PAR IGUAL: UM endereço (A ×5) ⇒ {comp-a: 5}, carimbado e o aviso resolvido', async () => {
    const db = new FakeDb();
    semearDuasListagensDeA(db);

    const res = await importarKitShopee(
      deps(db),
      entrada19(kitDeLinhas([{ item: COMPONENTE_A, q: 5 }])),
    );

    const membro = idDoFilhoPlanejado(PAI_19, KIT_MODELO);
    expect(docDoProduto(db, membro).componentesKit).toMatchObject({ 'comp-a': { quantidade: 5 } });
    expect(linhaDoKit(db, membro)?.receitaKitConferida).toBe(digital(5));
    expect(res.kit.avisos).toEqual([]);
    expect(avisoDoKit(db)?.resolvidoEm).not.toBeNull();
  });

  it('⛔ NEAR-MISS: DOIS endereços no MESMO produto (A ×2 + B ×3) ⇒ o MESMO {comp-a: 5}, mas o carimbo é LIMPO e o aviso ABRE', async () => {
    const db = new FakeDb();
    semearDuasListagensDeA(db);
    await importarKitShopee(deps(db), entrada19(kitDeLinhas([{ item: COMPONENTE_A, q: 5 }])));
    const membro = idDoFilhoPlanejado(PAI_19, KIT_MODELO);
    expect(linhaDoKit(db, membro)?.receitaKitConferida).toBe(digital(5));

    // O kit lido agora soma 5 por DOIS anúncios do mesmo produto: a Shopee
    // deriva min(S/2, S/3) = S/3, o ERP disponibiliza S/5.
    const res = await importarKitShopee(
      deps(db, { nowMs: AGORA + 1 }),
      entrada19(
        kitDeLinhas([
          { item: COMPONENTE_A, q: 2 },
          { item: COMPONENTE_B, q: 3 },
        ]),
      ),
    );

    // O mapa (a verdade no nível do produto) é o mesmo…
    expect(docDoProduto(db, membro).componentesKit).toMatchObject({ 'comp-a': { quantidade: 5 } });
    // …mas a linha deixa de dizer "conferida", e o aviso abre.
    expect(linhaDoKit(db, membro)?.receitaKitConferida).toBeNull();
    expect(avisoDoKit(db)?.resolvidoEm).toBeNull();
    expect(res.kit.avisos).toEqual([]);
  });

  it('⛔ NEAR-MISS: o PRIMEIRO import de um kit infiel cria a linha SEM carimbo — nunca pré-carimbado', async () => {
    const db = new FakeDb();
    semearDuasListagensDeA(db);

    await importarKitShopee(
      deps(db),
      entrada19(
        kitDeLinhas([
          { item: COMPONENTE_A, q: 2 },
          { item: COMPONENTE_B, q: 3 },
        ]),
      ),
    );

    const membro = idDoFilhoPlanejado(PAI_19, KIT_MODELO);
    expect(linhaDoKit(db, membro)?.receitaKitConferida).toBeNull();
    expect(db.writes.filter((w) => typeof w.patch.receitaKitConferida === 'string')).toEqual([]);
  });
});

describe('passo 19 — o pré-carimbo é um `mergeIfExists` PLANO (M53)', () => {
  const caminho = 'produtos/filho-x/variashopee/linha-x';

  it('carimba só o campo — um `precoEnviadoEm` semeado sobrevive', async () => {
    const db = new FakeDb();
    db.seed(caminho, {
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: 'documents/produtos/k/prodshopee/v',
      model_id: KIT_MODELO,
      precoEnviadoEm: 123,
      receitaKitConferida: 'velho',
    });

    await preCarimbarLinhasDoKit(asDb(db), [
      { produtoId: 'filho-x', docId: 'linha-x', receitaKitConferida: digital(2) },
    ]);

    expect(db.store[caminho]?.data).toMatchObject({
      precoEnviadoEm: 123,
      model_id: KIT_MODELO,
      receitaKitConferida: digital(2),
    });
  });

  it('⛔ uma linha APAGADA antes do pré-carimbo continua ausente — nunca um fantasma sem `model_id`', async () => {
    const db = new FakeDb();

    await preCarimbarLinhasDoKit(asDb(db), [
      { produtoId: 'filho-x', docId: 'linha-x', receitaKitConferida: digital(2) },
    ]);

    expect(db.store[caminho]).toBeUndefined();
  });
});

describe('passo 19 — lerCarimbosContados: QUAIS linhas contam (o escopo do R-t)', () => {
  it('conta só a conta e só vínculos nativos ATIVOS — nas DUAS grafias do ref', async () => {
    const db = new FakeDb();
    const conta2 = toOuterRef('integracao/int-2');
    db.seed('produtos/k/prodshopee/ativo', {
      contaProdutoShopeeOuterRef: REF_CONTA,
      kitNativo: true,
      item_id: KIT_GEMEO,
    });
    db.seed('produtos/k/prodshopee/comum', {
      contaProdutoShopeeOuterRef: REF_CONTA,
      kitNativo: false,
      item_id: 2500139861,
    });
    db.seed('produtos/k/prodshopee/removido', {
      contaProdutoShopeeOuterRef: REF_CONTA,
      kitNativo: true,
      item_id: 2500139872,
      estadoAnuncio: 'removido',
    });
    db.seed('produtos/k/prodshopee/outra-conta', {
      contaProdutoShopeeOuterRef: conta2,
      kitNativo: true,
      item_id: 2500139871,
    });
    const linha = (id: string, link: string, carimbo: string, conta = REF_CONTA): void =>
      db.seed(`produtos/f/variashopee/${id}`, {
        contaVariacaoShopeeOuterRef: conta,
        produtoShopeeOuterRef: link,
        model_id: KIT_MODELO,
        receitaKitConferida: carimbo,
      });
    linha('a', 'documents/produtos/k/prodshopee/ativo', 'conta-canonica');
    linha('b', 'produtos/k/prodshopee/ativo', 'conta-nua');
    linha('c', 'documents/produtos/k/prodshopee/comum', 'comum');
    linha('d', 'documents/produtos/k/prodshopee/removido', 'removido');
    linha('e', 'documents/produtos/k/prodshopee/outra-conta', 'outra-conta', conta2);
    linha('g', 'documents/produtos/k/prodshopee/ativo', 'conta-errada', conta2);
    linha('h', 'documents/produtos/k/prodshopee/ativo', 'conta-nua-da-conta', 'integracao/int-1');
    const plano = {
      itemId: KIT_ITEM,
      linkPai: { acao: 'add', docId: null, dados: { kitNativo: true, item_id: KIT_ITEM } },
      filhos: [{ modelId: KIT_MODELO }],
    } as unknown as PlanoImportacaoShopee;

    const contados = await lerCarimbosContados(asDb(db), INTEGRACAO, 'k', plano, [
      { id: 'f', raw: {} },
    ]);

    expect(contados).toEqual([['conta-canonica', 'conta-nua', 'conta-nua-da-conta']]);
  });

  it('⛔ uma listagem que NÃO ficará ativa não lê nada — ela não escreve receita', async () => {
    const db = new FakeDb();
    const plano = {
      itemId: KIT_ITEM,
      linkPai: {
        acao: 'merge',
        docId: 'v',
        dados: { kitNativo: true, item_id: KIT_ITEM, substituidoPorLinkDocId: 'outro' },
      },
      filhos: [{ modelId: KIT_MODELO }],
    } as unknown as PlanoImportacaoShopee;

    expect(
      await lerCarimbosContados(asDb(db), INTEGRACAO, 'k', plano, [{ id: 'f', raw: {} }]),
    ).toEqual([[]]);
    expect(db.opLog).toEqual([]);
  });
});
