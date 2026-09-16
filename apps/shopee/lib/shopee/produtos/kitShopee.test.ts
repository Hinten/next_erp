import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  shopeeCategoriaSchema,
  shopeeItemBaseInfoRowSchema,
  shopeeKitItemSchema,
  type ShopeeCategoria,
  type ShopeeClient,
  type ShopeeKitItem,
} from '@delfrance/integrations-shopee';
import {
  importacaoShopeeOptionsSchema,
  productArquivoId,
  type ImportacaoShopeeOptions,
} from '@delfrance/schemas';

import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { FakeBucket, asBucket } from '../testing/fakeBucket';
import { FakeDb, asDb } from '../testing/fakeDb';
import { criarMemoDeCategorias } from './categoriaShopee';
import { ShopeeImportBlockedError } from './errosImportacao';
import {
  anuncioDerivadoDoKit,
  comCamposDeKit,
  importarKitShopee,
  prepararImportacaoKitShopee,
  resolverComponentesDoKit,
  type ComponenteDoKitShopee,
} from './kitShopee';
import type { PlanoImportacaoShopee } from './planoImportacao';
import type { ImportarAnuncioDeps, ItemLido } from './itemLido';
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
    produtoId: 'pai-x',
    produtoPai: { produtoId: 'pai-x', criar: false, data: { nome: 'Kit' } },
    estoquePai: { produtoId: 'pai-x', docId: 'est-pai', criar: true, data: { quantidade: 7 } },
    filhoUnico: { paiId: 'pai-x', idsPlanejados: ['filho-x'] },
    filhos: [
      {
        modelId: 2000458802,
        produto: { produtoId: 'filho-x', criar: false, data: { nome: 'Kit A' } },
        estoque: { produtoId: 'filho-x', docId: 'est-f', criar: true, data: { quantidade: 7 } },
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
    const componentes = await resolverComponentesDoKit(asDb(db), INTEGRACAO, detalhe);

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

    const plano = comCamposDeKit(planoDeListagemComEstoque(), componentes, AGORA, {
      pai: null,
      filhos: [null],
    });

    expect(plano.estoquePai).toBeNull();
    expect(plano.filhos.map((f) => f.estoque)).toEqual([null]);
    // ÂNCORA: a transformação realmente rodou sobre este plano.
    expect(plano.produtoPai?.data.ehKit).toBe(true);
    expect(plano.filhos[0]?.produto?.data.componentesKit).toEqual({
      'comp-a': { quantidade: 1, limitarEstoque: true, timestamp: AGORA },
    });
  });

  it('o preço vai para a tabela NORMAL, no FILHO, só com importarPreco', async () => {
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
    // O pai tem filhos: quem vende é o filho, e o pai não carrega preço.
    expect(docDoProduto(db, PAI_ID).precos).toBeNull();
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
    expect(res.kit).toEqual({ componentes: 2, criado: true });
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
