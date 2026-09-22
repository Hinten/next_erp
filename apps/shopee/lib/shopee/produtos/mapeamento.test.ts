import { describe, expect, it } from 'vitest';

import {
  shopeeItemBaseInfoRowSchema,
  shopeeModelSchema,
  shopeePriceInfoSchema,
  type ShopeeModel,
  type ShopeePriceInfo,
  type ShopeeTaxInfo,
} from '@delfrance/integrations-shopee';
import { importacaoShopeeOptionsSchema, type ImportacaoShopeeOptions } from '@delfrance/schemas';

import type { ItemLido } from './itemLido';
import {
  CAMPOS_SOBRESCREVER_DADOS_PRODUTO,
  caminhoDoLinkDaListagem,
  dadosLinkListagem,
  dadosLinkVariacao,
  dimensaoDe,
  ehListagemDeletada,
  ehUsadoDe,
  estoqueDoVendedorDe,
  gtinDe,
  itemStatusDeLink,
  mapearFilho,
  mapearProdutoPai,
  marcaDe,
  modelStatusDeLink,
  nomesDasOpcoesDoModelo,
  pesoDe,
  precoBrlDe,
  type ArgsMapearFilho,
  type ArgsMapearProdutoPai,
  type PaiDoFilhoShopee,
} from './mapeamento';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;
const MODEL_ID = 2000458802;
const INTEGRACAO = 'int-1';
const TABELA_NORMAL = 'documents/listaDePrecos/tab-normal';
const TABELA_PROMOCIONAL = 'documents/listaDePrecos/tab-promo';
const DEPOSITO = 'documents/depositos/dep-1';
const AGORA = 1_757_000_000_000;

function opcoes(parcial: Partial<ImportacaoShopeeOptions> = {}): ImportacaoShopeeOptions {
  return importacaoShopeeOptionsSchema.parse(parcial);
}

function linha(parcial: Record<string, unknown> = {}) {
  return shopeeItemBaseInfoRowSchema.parse({
    item_id: ITEM_ID,
    item_name: 'Camiseta Básica',
    ...parcial,
  });
}

function item(
  parcial: Record<string, unknown> = {},
  extras: { models?: ItemLido['models']; taxInfo?: ShopeeTaxInfo | null } = {},
): ItemLido {
  return {
    base: linha(parcial),
    models: extras.models ?? null,
    taxInfo: extras.taxInfo ?? null,
    kit: null,
    itemId: ITEM_ID,
  };
}

function modelo(parcial: Record<string, unknown> = {}): ShopeeModel {
  return shopeeModelSchema.parse({ model_id: MODEL_ID, ...parcial });
}

function argsPai(parcial: Partial<ArgsMapearProdutoPai> = {}): ArgsMapearProdutoPai {
  return {
    entrada: item(),
    existente: null,
    existenteExtraData: null,
    options: opcoes(),
    nowMs: AGORA,
    integracaoId: INTEGRACAO,
    tabelaNormalOuterRef: TABELA_NORMAL,
    depositoOuterRef: DEPOSITO,
    categoriaOuterRef: null,
    temFilhos: false,
    estoqueExistente: null,
    ...parcial,
  };
}

const PAI_PADRAO: PaiDoFilhoShopee = {
  produtoId: 'pai-1',
  nome: 'Camiseta Básica',
  ehKit: false,
  ehUsado: false,
  categoriaOuterRef: null,
  pesoLiquidoKg: 2,
  pesoBrutoKg: 2,
  alturaCm: 10,
  larguraCm: 20,
  profundidadeCm: 30,
};

function argsFilho(parcial: Partial<ArgsMapearFilho> = {}): ArgsMapearFilho {
  return {
    entrada: item(),
    modelo: modelo(),
    pai: PAI_PADRAO,
    taxonomia: { grupoDeVariacoesUid: null, variacoesUid: null },
    existente: null,
    options: opcoes(),
    nowMs: AGORA,
    tabelaNormalOuterRef: TABELA_NORMAL,
    depositoOuterRef: DEPOSITO,
    estoqueExistente: null,
    ...parcial,
  };
}

const PRECO_BRL = [{ currency: 'BRL', original_price: 99.9, current_price: 49.9 }];

/** Uma entrada de `price_info` COMPLETA — a wire zera os campos que não usamos. */
function preco(parcial: Record<string, unknown>): ShopeePriceInfo {
  return shopeePriceInfoSchema.parse(parcial);
}

function precos(...entradas: Record<string, unknown>[]): ShopeePriceInfo[] {
  return entradas.map(preco);
}

/* ------------------------------ 1. os sentinelas -------------------------- */

describe('gtinDe', () => {
  it('trata `00` como "item sem GTIN" e devolve null, com ou sem espaços', () => {
    expect(gtinDe('00')).toBeNull();
    expect(gtinDe(' 00 ')).toBeNull();
  });

  it('⛔ NEAR-MISS: `0`, `000` e um GTIN com zeros à esquerda são MANTIDOS', () => {
    // Uma leitura numérica (`Number(gtin) === 0`) engoliria os três, e os zeros
    // à esquerda de um GTIN real são significativos.
    expect(gtinDe('0')).toBe('0');
    expect(gtinDe('000')).toBe('000');
    expect(gtinDe('0012345678905')).toBe('0012345678905');
  });
});

describe('pesoDe', () => {
  it('lê a STRING em kg como número, ignorando espaços', () => {
    expect(pesoDe('1.1')).toBe(1.1);
    expect(pesoDe(' 1.1 ')).toBe(1.1);
  });

  it('⛔ NEAR-MISS: `0`, vazio, negativo e a vírgula decimal viram null — sem DEFAULT', () => {
    expect(pesoDe('0')).toBeNull();
    expect(pesoDe('')).toBeNull();
    expect(pesoDe('-1')).toBeNull();
    // A wire documenta ponto decimal. `1,1` não é 1.1 aqui: isto não é entrada
    // de operador, e adivinhar seria inventar uma medida.
    expect(pesoDe('1,1')).toBeNull();
    expect(pesoDe(null)).toBeNull();
  });
});

describe('dimensaoDe', () => {
  it('usa o mapa de eixos: width→largura, length→profundidade, height→altura', () => {
    expect(dimensaoDe({ package_height: 10, package_width: 20, package_length: 30 })).toEqual({
      alturaCm: 10,
      larguraCm: 20,
      profundidadeCm: 30,
    });
  });

  it('⛔ NEAR-MISS: `0` e ausente viram null — não são a mesma afirmação que zero', () => {
    expect(dimensaoDe({ package_height: 0, package_width: 20 })).toEqual({
      alturaCm: null,
      larguraCm: 20,
      profundidadeCm: null,
    });
    expect(dimensaoDe(null)).toEqual({
      alturaCm: null,
      larguraCm: null,
      profundidadeCm: null,
    });
  });
});

describe('ehUsadoDe', () => {
  it('dobra USED/Used/used/" used " para true', () => {
    expect(ehUsadoDe('USED')).toBe(true);
    expect(ehUsadoDe('Used')).toBe(true);
    expect(ehUsadoDe('used')).toBe(true);
    expect(ehUsadoDe(' used ')).toBe(true);
  });

  it('⛔ NEAR-MISS: `unused`, `USED-LIKE-NEW` e `NEW` NÃO são usado', () => {
    expect(ehUsadoDe('unused')).toBe(false);
    expect(ehUsadoDe('USED-LIKE-NEW')).toBe(false);
    expect(ehUsadoDe('NEW')).toBe(false);
    expect(ehUsadoDe(null)).toBe(false);
  });
});

describe('marcaDe', () => {
  it('`brand_id: 0` e as duas grafias de "sem marca" viram null', () => {
    expect(marcaDe({ brand_id: 0, original_brand_name: 'Qualquer' })).toBeNull();
    expect(marcaDe({ brand_id: 7, original_brand_name: 'No brand' })).toBeNull();
    expect(marcaDe({ brand_id: 7, original_brand_name: 'NoBrand' })).toBeNull();
    expect(marcaDe({ brand_id: 7, original_brand_name: ' no brand ' })).toBeNull();
  });

  it('⛔ NEAR-MISS: `No Brand Shoes`, `Nobrandia` e `Nob Rand` são marcas REAIS', () => {
    // Sem remoção de espaços e sem remoção de acentos: o conjunto é de dois
    // membros exatos depois de trim+lowercase.
    expect(marcaDe({ brand_id: 7, original_brand_name: 'No Brand Shoes' })).toBe('No Brand Shoes');
    expect(marcaDe({ brand_id: 7, original_brand_name: 'Nobrandia' })).toBe('Nobrandia');
    expect(marcaDe({ brand_id: 7, original_brand_name: 'Nob Rand' })).toBe('Nob Rand');
  });
});

describe('itemStatusDeLink / modelStatusDeLink / ehListagemDeletada', () => {
  it('escreve os seis valores de wire conhecidos', () => {
    expect(itemStatusDeLink(item({ item_status: 'NORMAL' }))).toBe('NORMAL');
    expect(itemStatusDeLink(item({ item_status: 'UNLIST' }))).toBe('UNLIST');
    expect(itemStatusDeLink(item({ item_status: 'SHOPEE_DELETE' }))).toBe('SHOPEE_DELETE');
  });

  it('⛔ NEAR-MISS: um status que a Shopee inventar amanhã custa UM CAMPO, não um item', () => {
    expect(itemStatusDeLink(item({ item_status: 'DELETED' }))).toBeNull();
    expect(itemStatusDeLink(item({ item_status: 'normal' }))).toBeNull();
    expect(modelStatusDeLink('MODEL_NORMAL')).toBe('MODEL_NORMAL');
    expect(modelStatusDeLink('MODEL_SOMETHING')).toBeNull();
  });

  it('reconhece as DUAS grafias de exclusão', () => {
    expect(ehListagemDeletada(item({ item_status: 'SELLER_DELETE' }))).toBe(true);
    expect(ehListagemDeletada(item({ item_status: 'SHOPEE_DELETE' }))).toBe(true);
    expect(ehListagemDeletada(item({ item_status: 'UNLIST' }))).toBe(false);
  });
});

/* ------------------------------- 2. os preços ----------------------------- */

describe('precoBrlDe', () => {
  it('pega a PRIMEIRA entrada BRL e o `original_price` — o preço de prateleira', () => {
    expect(
      precoBrlDe(
        precos(
          { currency: 'SGD', original_price: 10, current_price: 10 },
          { currency: 'BRL', original_price: 99.9, current_price: 49.9 },
          { currency: 'BRL', original_price: 11.1, current_price: 11.1 },
        ),
      ),
    ).toEqual({ valor: 99.9, motivo: null });
  });

  it('⛔ NEAR-MISS: um `current_price` MENOR é ignorado — a promoção não vira preço normal', () => {
    expect(precoBrlDe(precos(...PRECO_BRL)).valor).toBe(99.9);
    expect(precoBrlDe(precos(...PRECO_BRL)).valor).not.toBe(49.9);
  });

  it('⛔ NEAR-MISS: `brl` minúsculo NÃO casa com a moeda', () => {
    expect(precoBrlDe(precos({ currency: 'brl', original_price: 10, current_price: 10 }))).toEqual({
      valor: null,
      motivo: 'moeda-nao-brl',
    });
  });

  it('cai no `current_price` quando o `original_price` é zero-fill', () => {
    // Desvio deliberado do literal `original_price ?? current_price`: a Shopee
    // preenche com zero, e o `??` só descarta null — tomado ao pé da letra, o
    // catálogo inteiro sem promoção importaria SEM preço.
    expect(precoBrlDe(precos({ currency: 'BRL', original_price: 0, current_price: 12.5 }))).toEqual(
      {
        valor: 12.5,
        motivo: null,
      },
    );
  });

  it('recusa um valor abaixo do mínimo do schema e diz por quê', () => {
    expect(precoBrlDe(precos({ currency: 'BRL', original_price: 0, current_price: 0 }))).toEqual({
      valor: null,
      motivo: 'valor-abaixo-do-minimo',
    });
    expect(
      precoBrlDe(precos({ currency: 'BRL', original_price: 0.009, current_price: 0.009 })).motivo,
    ).toBe('valor-abaixo-do-minimo');
  });

  it('`price_info` ausente ou vazio é `sem-price-info`, não uma moeda errada', () => {
    expect(precoBrlDe(null)).toEqual({ valor: null, motivo: 'sem-price-info' });
    expect(precoBrlDe([])).toEqual({ valor: null, motivo: 'sem-price-info' });
  });
});

describe('a tabela PROMOCIONAL nunca é escrita (decisão do Lucas / #803)', () => {
  it('⛔ nenhum patch do mapeador cita `tabelaPromocionalOuterRef` nem o id da tabela promocional', () => {
    const mapa = mapearProdutoPai(argsPai({ entrada: item({ price_info: PRECO_BRL }) }));
    const serializado = JSON.stringify([mapa.patchProduto, mapa.patchExtraData, mapa.precos]);
    expect(serializado).not.toContain('tabelaPromocional');
    expect(serializado).not.toContain('tab-promo');
    expect(TABELA_PROMOCIONAL).toContain('tab-promo'); // a âncora existe mesmo
    expect(mapa.precos).toEqual({ tabelaId: 'tab-normal', valor: 99.9 });
  });

  it('uma loja SGD não planeja preço nenhum e o motivo diz `moeda-nao-brl`', () => {
    const mapa = mapearProdutoPai(
      argsPai({
        entrada: item({ price_info: [{ currency: 'SGD', original_price: 10, current_price: 9 }] }),
      }),
    );
    expect(mapa.precos).toBeNull();
    expect(mapa.precoIgnorado).toBe('moeda-nao-brl');
    expect(mapa.patchProduto.precos).toBeNull();
  });
});

/* ------------------------------- 3. o estoque ----------------------------- */

describe('estoqueDoVendedorDe', () => {
  it('soma `seller_stock`', () => {
    expect(
      estoqueDoVendedorDe({
        seller_stock: [{ stock: 3 }, { stock: 4 }],
      } as never),
    ).toBe(7);
  });

  it('⛔ NEAR-MISS: `shopee_stock` NUNCA entra na soma', () => {
    expect(
      estoqueDoVendedorDe({
        seller_stock: [{ stock: 3 }],
        shopee_stock: [{ stock: 100 }],
      } as never),
    ).toBe(3);
  });

  it('distingue "a Shopee não falou" (null) de "a Shopee disse zero" (0)', () => {
    expect(estoqueDoVendedorDe(null)).toBeNull();
    expect(estoqueDoVendedorDe({ seller_stock: null } as never)).toBeNull();
    expect(estoqueDoVendedorDe({ seller_stock: [] } as never)).toBe(0);
  });
});

describe('mapearProdutoPai — estoque', () => {
  const comEstoque = (parcial: Partial<ArgsMapearProdutoPai> = {}) =>
    mapearProdutoPai(
      argsPai({
        entrada: item({ stock_info_v2: { seller_stock: [{ stock: 5 }] } }),
        ...parcial,
      }),
    );

  it('cria a linha sob `importarEstoque` no uid canônico', () => {
    const mapa = comEstoque();
    expect(mapa.estoque).toEqual({
      docId: `est-${mapa.produtoId}-dep-1`,
      criar: true,
      quantidade: 5,
    });
  });

  it('soma a reserva EFETIVA para que `disponivel` continue igual ao da Shopee', () => {
    const mapa = comEstoque({
      options: opcoes({ sobrescreverEstoque: true }),
      estoqueExistente: { docId: 'auto-legado', quantidade: 1, quantidadeReservada: 2 },
    });
    expect(mapa.estoque).toEqual({ docId: 'auto-legado', criar: false, quantidade: 7 });
  });

  it('⛔ NEAR-MISS: uma reserva NEGATIVA armazenada não ENCOLHE a contagem (#931)', () => {
    const mapa = comEstoque({
      options: opcoes({ sobrescreverEstoque: true }),
      estoqueExistente: { docId: 'auto-legado', quantidade: 1, quantidadeReservada: -2 },
    });
    expect(mapa.estoque?.quantidade).toBe(5);
    expect(mapa.estoque?.quantidade).not.toBe(3);
  });

  it('escreve na linha que LEU, nunca no uid canônico, quando a linha é legada', () => {
    const mapa = comEstoque({
      options: opcoes({ sobrescreverEstoque: true }),
      estoqueExistente: { docId: 'auto-id-do-flutter', quantidade: 0, quantidadeReservada: 0 },
    });
    expect(mapa.estoque?.docId).toBe('auto-id-do-flutter');
  });

  it('não sobrescreve uma linha existente sem `sobrescreverEstoque` (o padrão)', () => {
    const mapa = comEstoque({
      estoqueExistente: { docId: 'auto-legado', quantidade: 9, quantidadeReservada: 0 },
    });
    expect(mapa.estoque).toBeNull();
    expect(mapa.estoqueIgnorado).toBe('sem-sobrescrever');
  });

  it('⛔ NEAR-MISS: NUNCA escreve estoque num pai que tem filhos — nem pelo payload, nem pelo ERP', () => {
    expect(comEstoque({ temFilhos: true }).estoque).toBeNull();
    expect(comEstoque({ temFilhos: true }).estoqueIgnorado).toBe('pai-com-filhos');
    // e o preço do pai cai pelo mesmo motivo, com o motivo certo
    expect(comEstoque({ temFilhos: true }).precoIgnorado).toBe('pai-com-filhos');
  });

  it('sem `depositoOuterRef` pula a escrita e diz por quê, sem lançar', () => {
    const mapa = comEstoque({ depositoOuterRef: null });
    expect(mapa.estoque).toBeNull();
    expect(mapa.estoqueIgnorado).toBe('sem-deposito');
  });

  it('`stock_info_v2` ausente é `sem-stock-info`, nunca uma quantidade zero inventada', () => {
    const mapa = mapearProdutoPai(argsPai());
    expect(mapa.estoque).toBeNull();
    expect(mapa.estoqueIgnorado).toBe('sem-stock-info');
  });
});

/* ------------------------- 4. a regra de preenchimento -------------------- */

describe('a regra de preenchimento (as três cláusulas)', () => {
  const existente = (raw: Record<string, unknown>) => ({ id: 'p-1', raw });

  it('1. um valor ARMAZENADO em branco sempre recebe o valor novo', () => {
    const mapa = mapearProdutoPai(
      argsPai({
        entrada: item({ item_sku: 'SKU-NOVO' }),
        existente: existente({ sku: null }),
      }),
    );
    expect(mapa.patchProduto.sku).toBe('SKU-NOVO');
  });

  it('2. um valor ARMAZENADO preenchido só é trocado sob `sobrescreverDadosProduto`', () => {
    const base = {
      entrada: item({ item_sku: 'SKU-NOVO' }),
      existente: existente({ sku: 'SKU-DO-OPERADOR' }),
    };
    expect(mapearProdutoPai(argsPai(base)).patchProduto.sku).toBeUndefined();
    expect(
      mapearProdutoPai(argsPai({ ...base, options: opcoes({ sobrescreverDadosProduto: true }) }))
        .patchProduto.sku,
    ).toBe('SKU-NOVO');
  });

  it('⛔ 3. um valor NOVO nulo nunca aterrissa — nem com o carve-out ligado', () => {
    // "A Shopee não reportar um campo não é uma instrução para apagar a cópia do ERP."
    const mapa = mapearProdutoPai(
      argsPai({
        entrada: item({ item_sku: null, weight: null }),
        existente: existente({ sku: 'SKU-DO-OPERADOR', pesoLiquidoKg: 3 }),
        options: opcoes({ sobrescreverDadosProduto: true }),
      }),
    );
    expect(mapa.patchProduto).not.toHaveProperty('sku');
    expect(mapa.patchProduto).not.toHaveProperty('pesoLiquidoKg');
  });

  it('⛔ o carve-out morre junto com `atualizarProdutoPai` — derivado UMA vez', () => {
    const mapa = mapearProdutoPai(
      argsPai({
        entrada: item({ item_sku: 'SKU-NOVO' }),
        existente: existente({ sku: 'SKU-DO-OPERADOR' }),
        options: opcoes({ atualizarProdutoPai: false, sobrescreverDadosProduto: true }),
      }),
    );
    expect(mapa.patchProduto).not.toHaveProperty('sku');
  });

  it('a lista do carve-out é EXATAMENTE esta', () => {
    expect([...CAMPOS_SOBRESCREVER_DADOS_PRODUTO]).toEqual([
      'sku',
      'pesoLiquidoKg',
      'pesoBrutoKg',
      'alturaCm',
      'larguraCm',
      'profundidadeCm',
      'extraData.marca',
    ]);
  });

  it('⛔ NEAR-MISS: `gtin` NÃO está no carve-out — é só preenche-em-branco', () => {
    expect([...CAMPOS_SOBRESCREVER_DADOS_PRODUTO]).not.toContain('gtin');
    const mapa = mapearProdutoPai(
      argsPai({
        entrada: item({ gtin_code: '7891234567895' }),
        existente: existente({ gtin: '0000000000000' }),
        options: opcoes({ sobrescreverDadosProduto: true }),
      }),
    );
    expect(mapa.patchProduto).not.toHaveProperty('gtin');
  });

  it('⛔ NEAR-MISS: `descricao` NÃO está no carve-out e nunca é sobrescrita', () => {
    expect([...CAMPOS_SOBRESCREVER_DADOS_PRODUTO]).not.toContain('descricao');
    const mapa = mapearProdutoPai(
      argsPai({
        entrada: item({ description: 'Nova descrição' }),
        existente: existente({}),
        existenteExtraData: { descricao: 'A descrição que o operador escreveu' },
        options: opcoes({ sobrescreverDadosProduto: true }),
      }),
    );
    expect(mapa.patchExtraData ?? {}).not.toHaveProperty('descricao');
  });

  it('`extraData.marca` ESTÁ no carve-out e só então troca uma marca digitada', () => {
    const base = {
      entrada: item({ brand: { brand_id: 7, original_brand_name: 'Marca Shopee' } }),
      existente: existente({}),
      existenteExtraData: { marca: 'Marca Do Operador' },
    };
    expect(mapearProdutoPai(argsPai(base)).patchExtraData ?? {}).not.toHaveProperty('marca');
    expect(
      mapearProdutoPai(argsPai({ ...base, options: opcoes({ sobrescreverDadosProduto: true }) }))
        .patchExtraData?.marca,
    ).toBe('Marca Shopee');
  });
});

/* --------------------------- 5. o produto pai ----------------------------- */

describe('mapearProdutoPai — o documento', () => {
  it('cria no id determinístico com `publicado: true` e os dois carimbos em ms', () => {
    const mapa = mapearProdutoPai(argsPai({ entrada: item({ price_info: PRECO_BRL }) }));
    expect(mapa.criar).toBe(true);
    expect(mapa.produtoId).toMatch(/^[0-9a-f]{64}$/);
    expect(mapa.patchProduto.publicado).toBe(true);
    expect(mapa.patchProduto.paiId).toBeNull();
    expect(mapa.patchProduto.timestamp).toBe(AGORA);
    expect(mapa.patchProduto.ultimaModificacao).toBe(AGORA);
    // Na criação o preço é DOBRADO no documento — não há nada a limpar.
    expect(mapa.patchProduto.precos).toEqual({ 'tab-normal': { valor: 99.9 } });
  });

  it('corta o nome em 100 caracteres', () => {
    const mapa = mapearProdutoPai(argsPai({ entrada: item({ item_name: 'x'.repeat(150) }) }));
    expect(String(mapa.patchProduto.nome)).toHaveLength(100);
  });

  it('⛔ NEAR-MISS: uma reimportação NÃO republica um produto que o operador ocultou', () => {
    const mapa = mapearProdutoPai(argsPai({ existente: { id: 'p-1', raw: { publicado: false } } }));
    expect(mapa.patchProduto).not.toHaveProperty('publicado');
  });

  it('`crossdocking` só é escrito quando o anúncio é pré-venda', () => {
    const comPre = mapearProdutoPai(
      argsPai({ entrada: item({ pre_order: { is_pre_order: true, days_to_ship: 3 } }) }),
    );
    expect(comPre.patchProduto.crossdocking).toBe(3);
  });

  it('⛔ NEAR-MISS: `is_pre_order: false` com `days_to_ship: 3` não escreve NADA', () => {
    const mapa = mapearProdutoPai(
      argsPai({
        entrada: item({ pre_order: { is_pre_order: false, days_to_ship: 3 } }),
        existente: { id: 'p-1', raw: {} },
      }),
    );
    expect(mapa.patchProduto).not.toHaveProperty('crossdocking');
  });

  it('⛔ nunca escreve os campos de PESO MORTO nem as flags proibidas', () => {
    const mapa = mapearProdutoPai(argsPai({ entrada: item({ price_info: PRECO_BRL }) }));
    for (const proibido of [
      'integracoesComProduto',
      'permiteVendaSemEstoque',
      'ofereceFreteGratis',
      'tabelaDeMedidasModaUid',
    ]) {
      expect(mapa.patchProduto).not.toHaveProperty(proibido);
    }
  });

  it('a categoria é preenche-em-branco, com gate próprio, e nunca clobbera a do operador', () => {
    const nova = mapearProdutoPai(
      argsPai({
        existente: { id: 'p-1', raw: { categoriaProdutoOuterRef: null } },
        categoriaOuterRef: 'documents/categorias/shopee-100',
        options: opcoes({ atualizarProdutoPai: false }),
      }),
    );
    expect(nova.patchProduto.categoriaProdutoOuterRef).toBe('documents/categorias/shopee-100');

    const preservada = mapearProdutoPai(
      argsPai({
        existente: { id: 'p-1', raw: { categoriaProdutoOuterRef: 'documents/categorias/minha' } },
        categoriaOuterRef: 'documents/categorias/shopee-100',
        options: opcoes({ sobrescreverDadosProduto: true }),
      }),
    );
    expect(preservada.patchProduto).not.toHaveProperty('categoriaProdutoOuterRef');
  });

  it('a `condicao` do extraData é escrita só na criação, a partir de `ehUsado`', () => {
    expect(
      mapearProdutoPai(argsPai({ entrada: item({ condition: 'USED' }) })).patchExtraData?.condicao,
    ).toBe(2);
    expect(mapearProdutoPai(argsPai()).patchExtraData?.condicao).toBe(1);
    expect(
      mapearProdutoPai(argsPai({ existente: { id: 'p-1', raw: {} } })).patchExtraData ?? {},
    ).not.toHaveProperty('condicao');
  });

  it('a descrição estendida entra cortada em 3000 e uma só de IMAGENS não entra', () => {
    const estendida = mapearProdutoPai(
      argsPai({
        entrada: item({
          description_type: 'extended',
          description_info: {
            extended_description: { field_list: [{ field_type: 'text', text: 'y'.repeat(4000) }] },
          },
        }),
      }),
    );
    expect(String(estendida.patchExtraData?.descricao)).toHaveLength(3000);

    const soImagens = mapearProdutoPai(
      argsPai({
        entrada: item({
          description: '',
          description_type: 'extended',
          description_info: {
            extended_description: {
              field_list: [{ field_type: 'image', image_info: { image_id: 'i1' } }],
            },
          },
        }),
      }),
    );
    expect(soImagens.patchExtraData ?? {}).not.toHaveProperty('descricao');
  });

  it('o preço do UPDATE não entra no patch do produto — ele é a escrita guardada', () => {
    const mapa = mapearProdutoPai(
      argsPai({ entrada: item({ price_info: PRECO_BRL }), existente: { id: 'p-1', raw: {} } }),
    );
    expect(mapa.patchProduto).not.toHaveProperty('precos');
    expect(mapa.precos).toEqual({ tabelaId: 'tab-normal', valor: 99.9 });
  });

  it('sem `tabelaNormalOuterRef` o preço é pulado com o motivo certo', () => {
    const mapa = mapearProdutoPai(
      argsPai({ entrada: item({ price_info: PRECO_BRL }), tabelaNormalOuterRef: null }),
    );
    expect(mapa.precos).toBeNull();
    expect(mapa.precoIgnorado).toBe('sem-tabela');
  });

  it('as duas opções de preço são lidas nos lados certos (criar vs atualizar)', () => {
    expect(
      mapearProdutoPai(
        argsPai({
          entrada: item({ price_info: PRECO_BRL }),
          options: opcoes({ importarPreco: false }),
        }),
      ).precoIgnorado,
    ).toBe('opcao-desligada');
    expect(
      mapearProdutoPai(
        argsPai({
          entrada: item({ price_info: PRECO_BRL }),
          existente: { id: 'p-1', raw: {} },
          options: opcoes({ sobrescreverPreco: false }),
        }),
      ).precoIgnorado,
    ).toBe('opcao-desligada');
  });
});

/* ------------------------------- 6. os filhos ----------------------------- */

const TIERS = {
  tier_variation: [
    { name: 'Cor', option_list: [{ option: 'Azul' }, { option: 'Verde' }] },
    { name: 'Tamanho', option_list: [{ option: 'P' }, { option: 'M' }] },
  ],
  standardise_tier_variation: null,
  model: [],
} as unknown as ItemLido['models'];

describe('nomesDasOpcoesDoModelo', () => {
  it('lê as opções na ordem dos tiers', () => {
    expect(nomesDasOpcoesDoModelo(TIERS?.tier_variation ?? [], [0, 1])).toEqual(['Azul', 'M']);
  });

  it('⛔ NEAR-MISS: um índice fora dos limites não lança e não contribui NADA', () => {
    expect(nomesDasOpcoesDoModelo(TIERS?.tier_variation ?? [], [9, 1])).toEqual(['M']);
    expect(nomesDasOpcoesDoModelo(TIERS?.tier_variation ?? [], [0, 1, 2])).toEqual(['Azul', 'M']);
    expect(nomesDasOpcoesDoModelo([], [0])).toEqual([]);
  });
});

describe('mapearFilho', () => {
  const entradaComTiers = item({}, { models: TIERS });

  it('compõe o nome com o pai e as opções, cortado em 100', () => {
    const mapa = mapearFilho(
      argsFilho({ entrada: entradaComTiers, modelo: modelo({ tier_index: [0, 1] }) }),
    );
    expect(mapa.patchProduto.nome).toBe('Camiseta Básica Azul M');
  });

  it('cai no `model_sku ?? model_id` quando nenhuma opção resolve', () => {
    expect(
      mapearFilho(
        argsFilho({
          entrada: entradaComTiers,
          modelo: modelo({ tier_index: [9, 9], model_sku: 'MSKU-1' }),
        }),
      ).patchProduto.nome,
    ).toBe('Camiseta Básica MSKU-1');
    expect(
      mapearFilho(argsFilho({ entrada: entradaComTiers, modelo: modelo({ tier_index: [9, 9] }) }))
        .patchProduto.nome,
    ).toBe(`Camiseta Básica ${String(MODEL_ID)}`);
  });

  it('usa o `model_sku` VERBATIM e em branco vira null', () => {
    expect(
      mapearFilho(argsFilho({ modelo: modelo({ model_sku: 'A-B_c' }) })).patchProduto.sku,
    ).toBe('A-B_c');
    expect(
      mapearFilho(argsFilho({ modelo: modelo({ model_sku: '  ' }) })).patchProduto.sku,
    ).toBeNull();
  });

  it('⛔ NEAR-MISS: um anúncio de UM modelo NÃO recebe sufixo `-UN` (C26)', () => {
    const mapa = mapearFilho(argsFilho({ modelo: modelo({ model_sku: 'PAI-SKU' }) }));
    expect(mapa.patchProduto.sku).toBe('PAI-SKU');
    expect(String(mapa.patchProduto.sku)).not.toContain('-UN');
    expect(JSON.stringify(mapa.patchProduto)).not.toContain('-UN');
  });

  it('o filho tem PREÇO PRÓPRIO — divergência real do Mercado Livre', () => {
    const mapa = mapearFilho(
      argsFilho({ modelo: modelo({ price_info: [{ currency: 'BRL', original_price: 42 }] }) }),
    );
    expect(mapa.patchProduto.precos).toEqual({ 'tab-normal': { valor: 42 } });
  });

  it('herda as dimensões do ITEM quando o modelo não tem as suas', () => {
    const mapa = mapearFilho(argsFilho());
    expect(mapa.patchProduto.alturaCm).toBe(10);
    expect(mapa.patchProduto.pesoLiquidoKg).toBe(2);
  });

  it('as dimensões PRÓPRIAS do modelo vencem as do item', () => {
    const mapa = mapearFilho(
      argsFilho({ modelo: modelo({ weight: '0.4', dimension: { package_height: 1 } }) }),
    );
    expect(mapa.patchProduto.pesoLiquidoKg).toBe(0.4);
    expect(mapa.patchProduto.alturaCm).toBe(1);
    expect(mapa.patchProduto.larguraCm).toBe(20); // sem a sua, a do item
  });

  it('espelha `ehKit`/`ehUsado` do pai e aponta `paiId` para ele', () => {
    const mapa = mapearFilho(argsFilho({ pai: { ...PAI_PADRAO, ehKit: true, ehUsado: true } }));
    expect(mapa.patchProduto.ehKit).toBe(true);
    expect(mapa.patchProduto.ehUsado).toBe(true);
    expect(mapa.patchProduto.paiId).toBe('pai-1');
  });

  it('a taxonomia é preenche-em-branco-OU-VAZIO no update', () => {
    const taxonomia = {
      grupoDeVariacoesUid: ['g1'],
      variacoesUid: ['documents/grupoDeVariacoes/g1/variacoes/v1'],
    };
    expect(
      mapearFilho(argsFilho({ taxonomia, existente: { id: 'f-1', raw: { variacoesUid: [] } } }))
        .patchProduto.variacoesUid,
    ).toEqual(taxonomia.variacoesUid);
    expect(
      mapearFilho(
        argsFilho({ taxonomia, existente: { id: 'f-1', raw: { variacoesUid: ['ja-existia'] } } }),
      ).patchProduto,
    ).not.toHaveProperty('variacoesUid');
  });

  it('o id do filho é derivado do pai e do `model_id`', () => {
    const mapa = mapearFilho(argsFilho());
    expect(mapa.produtoId).toMatch(/^[0-9a-f]{64}$/);
    expect(mapa.produtoId).not.toBe(PAI_PADRAO.produtoId);
  });
});

/* -------------------------- 7. os dois documentos de vínculo -------------- */

describe('dadosLinkListagem', () => {
  const entradaCompleta = item(
    {
      attribute_list: [{ attribute_id: 1, attribute_value_list: [] }],
      wholesales: [{ min_count: 2, unit_price: 9.9 }],
      brand: { brand_id: 0, original_brand_name: 'No brand' },
      logistic_info: [{ logistic_id: 1, logistic_name: 'Correios', size_id: 7 }],
      item_status: 'NORMAL',
    },
    { taxInfo: { ncm: '00', origin: '0', cest: '0000000' } as ShopeeTaxInfo },
  );

  it('aplica as TRÊS renomeações de container', () => {
    const doc = dadosLinkListagem(entradaCompleta, null, INTEGRACAO, AGORA);
    expect(doc.attributes).toEqual([
      {
        attribute_id: 1,
        attribute_value_list: [],
        is_mandatory: null,
        original_attribute_name: null,
      },
    ]);
    expect(doc.wholesale).toEqual([
      { min_count: 2, max_count: null, unit_price: 9.9, inflated_price_of_unit_price: null },
    ]);
    expect(doc.brand_id).toBe(0);
  });

  it('⛔ NEAR-MISS: as grafias de LEITURA não chegam ao documento', () => {
    const doc = dadosLinkListagem(entradaCompleta, null, INTEGRACAO, AGORA);
    expect(doc).not.toHaveProperty('attribute_list');
    expect(doc).not.toHaveProperty('wholesales');
    expect(doc).not.toHaveProperty('brand');
  });

  it('⛔ NEAR-MISS: a renomeação INTERNA de `unit_price` NÃO existe', () => {
    // O relatório do legado pedia `unit → unit_price`; o campo lido JÁ é
    // `unit_price`, e reaplicar a renomeação leria o preço de um campo inexistente.
    const wholesale = (dadosLinkListagem(entradaCompleta, null, INTEGRACAO, AGORA).wholesale ??
      []) as Record<string, unknown>[];
    expect(wholesale[0]).toHaveProperty('unit_price', 9.9);
    expect(wholesale[0]).not.toHaveProperty('unit');
  });

  it('guarda `logistic_info` VERBATIM, com os campos que o legado descartava', () => {
    const doc = dadosLinkListagem(entradaCompleta, null, INTEGRACAO, AGORA);
    const logistica = (doc.logistic_info ?? []) as Record<string, unknown>[];
    expect(logistica[0]).toMatchObject({ logistic_name: 'Correios', size_id: 7 });
  });

  it('guarda `tax_info` CRU, cada valor uma STRING', () => {
    const doc = dadosLinkListagem(entradaCompleta, null, INTEGRACAO, AGORA);
    expect(doc.tax_info).toMatchObject({ ncm: '00', origin: '0', cest: '0000000' });
    const tax = doc.tax_info as Record<string, unknown>;
    expect(typeof tax.ncm).toBe('string');
    expect(tax.origin).not.toBe(0);
  });

  it('⛔ um `tax_info` ausente NÃO apaga o bloco armazenado', () => {
    const doc = dadosLinkListagem(item(), { tax_info: { ncm: '1234' } }, INTEGRACAO, AGORA);
    expect(doc.tax_info).toEqual({ ncm: '1234' });
  });

  it('recarimba a conta DEPOIS do spread — o auto-reparo de uma ref que derivou', () => {
    const doc = dadosLinkListagem(
      entradaCompleta,
      { contaProdutoShopeeOuterRef: 'documents/integracao/outra' },
      INTEGRACAO,
      AGORA,
    );
    expect(doc.contaProdutoShopeeOuterRef).toBe('documents/integracao/int-1');
  });

  it('preserva `dataCadastro` e sempre carimba `ultimaModificacao` em ms', () => {
    expect(dadosLinkListagem(entradaCompleta, null, INTEGRACAO, AGORA).dataCadastro).toBe(AGORA);
    const doc = dadosLinkListagem(entradaCompleta, { dataCadastro: 111 }, INTEGRACAO, AGORA);
    expect(doc.dataCadastro).toBe(111);
    expect(doc.ultimaModificacao).toBe(AGORA);
  });

  it('⛔ nunca AUTORA `violations`, `complaint_policy`, `sku` nem `image`', () => {
    const doc = dadosLinkListagem(entradaCompleta, null, INTEGRACAO, AGORA);
    for (const proibido of ['violations', 'complaint_policy', 'sku', 'image', 'image_id_list']) {
      expect(doc).not.toHaveProperty(proibido);
    }
  });

  it('mas PRESERVA um `violations` que o push já escreveu', () => {
    const doc = dadosLinkListagem(
      entradaCompleta,
      { violations: [{ violation_reason: 'x' }] },
      INTEGRACAO,
      AGORA,
    );
    expect(doc.violations).toEqual([{ violation_reason: 'x' }]);
  });
});

describe('dadosLinkVariacao', () => {
  const caminho = caminhoDoLinkDaListagem('pai-1', 'link-1');

  it('aponta `produtoShopeeOuterRef` para o documento de VÍNCULO, não para o produto', () => {
    const doc = dadosLinkVariacao(modelo(), caminho, null, INTEGRACAO);
    expect(doc?.produtoShopeeOuterRef).toBe('documents/produtos/pai-1/prodshopee/link-1');
    expect(doc?.produtoShopeeOuterRef).not.toBe('documents/produtos/pai-1');
  });

  it('⛔ NEAR-MISS: `model_id: 0` NÃO gera vínculo nenhum', () => {
    expect(dadosLinkVariacao(modelo({ model_id: 0 }), caminho, null, INTEGRACAO)).toBeNull();
    expect(dadosLinkVariacao(modelo({ model_id: 1 }), caminho, null, INTEGRACAO)).not.toBeNull();
  });

  it('⛔ nunca carimba `promotion_id`, mas deixa um valor armazenado passar', () => {
    expect(
      dadosLinkVariacao(modelo({ promotion_id: 55 }), caminho, null, INTEGRACAO),
    ).not.toHaveProperty('promotion_id');
    expect(
      dadosLinkVariacao(modelo(), caminho, { promotion_id: 7 }, INTEGRACAO)?.promotion_id,
    ).toBe(7);
  });

  it('dobra `model_status` para os dois valores conhecidos e nada mais', () => {
    expect(
      dadosLinkVariacao(modelo({ model_status: 'MODEL_UNAVAILABLE' }), caminho, null, INTEGRACAO)
        ?.model_status,
    ).toBe('MODEL_UNAVAILABLE');
    expect(
      dadosLinkVariacao(modelo({ model_status: 'MODEL_X' }), caminho, null, INTEGRACAO)
        ?.model_status,
    ).toBeNull();
  });

  it('⛔ sem o id do vínculo pai, OMITE a ref — e a omissão é LOUD, não silenciosa', () => {
    // `variacaoShopeeLinkSchema.produtoShopeeOuterRef` é obrigatório e não
    // nulável: um carimbo esquecido quebra a escrita em vez de gravar um
    // ponteiro para um documento inexistente.
    const doc = dadosLinkVariacao(modelo(), null, null, INTEGRACAO);
    expect(doc).not.toHaveProperty('produtoShopeeOuterRef');
    expect(doc?.model_id).toBe(MODEL_ID);
  });

  it('carimba a conta e copia `tier_index`', () => {
    const doc = dadosLinkVariacao(modelo({ tier_index: [0, 1] }), caminho, null, INTEGRACAO);
    expect(doc?.contaVariacaoShopeeOuterRef).toBe('documents/integracao/int-1');
    expect(doc?.tier_index).toEqual([0, 1]);
  });
});
