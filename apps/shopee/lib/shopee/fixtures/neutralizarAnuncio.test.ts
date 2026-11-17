import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  ATUALIZACAO_NEUTRA,
  CAMPOS_NEUTRALIZADOS,
  CHAVES_DE_PRECO,
  CRIACAO_NEUTRA,
  ESTOQUE_NEUTRO,
  ErroDeNeutralizacao,
  PRECO_NEUTRO,
  PREFIXO_OPCAO_INVENTADA,
  neutralizarLeituraDeAnuncio,
} from './neutralizarAnuncio';
import type { WireValue } from './redact';

/**
 * SYNTHETIC listing reads — invented ids, names, prices, stock and times. They
 * use the wire's key PATHS, and the objects the transform writes into — a
 * listing row, a model, a `price_info` entry (`currency` LAST), the stock
 * blocks, the tiers and their options — keep the wire's RELATIVE key order, so
 * a transform that re-inserts a key moves it and the key-order tests see it.
 * They carry fewer keys than the wire does. Never a value copied from a
 * capture.
 *
 * The model list has two STANDARD tiers: Cor (101054) with three options, the
 * third seller-typed (`variation_option_id: 0`), and Tamanho (101056) with two.
 * Six models, one per pair, each `model_name` the comma-join of its options.
 */
const COR = ['Vermelho', 'Azul', 'Tom Livre Inventado'] as const;
const IDS_COR = [7001, 7002, 0] as const;
const TAMANHO = ['P', 'G'] as const;
const IDS_TAMANHO = [8001, 8002] as const;

type Obj = { [key: string]: WireValue };

function modelo(cor: number, tamanho: number, estoque: number): Obj {
  return {
    model_id: 900 + cor * 10 + tamanho,
    model_name: `${COR[cor] ?? ''},${TAMANHO[tamanho] ?? ''}`,
    promotion_id: 0,
    has_promotion: false,
    tier_index: [cor, tamanho],
    price_info: [
      {
        current_price: 37.5,
        original_price: 41.25,
        inflated_price_of_current_price: 39.9,
        inflated_price_of_original_price: 43.1,
        currency: 'BRL',
      },
    ],
    model_sku: `SKU-0000000${String(cor)}`,
    stock_info_v2: {
      summary_info: { total_reserved_stock: 2, total_available_stock: estoque },
      seller_stock: [{ location_id: 'LOCAL-INVENTADO', stock: estoque, if_saleable: true }],
      shopee_stock: [{ location_id: '', stock: 0 }],
      advance_stock: { sellable_advance_stock: 3, in_transit_advance_stock: 0 },
    },
    gtin_code: '00000000',
    weight: '0.35',
    dimension: { package_length: 21, package_width: 14, package_height: 3 },
  };
}

function listaDeModelos(): Obj {
  const modelos: Obj[] = [];
  COR.forEach((_, c) => {
    TAMANHO.forEach((__, t) => modelos.push(modelo(c, t, c === 1 ? 0 : 5 + c + t)));
  });
  return {
    error: '',
    message: '',
    warning: '',
    response: {
      tier_variation: [
        {
          name: 'Cor',
          option_list: COR.map((option) => ({
            option,
            image: { image_id: 'imagem-redigida', image_url: 'https://redacted.invalid/imagem' },
          })),
        },
        { name: 'Tamanho', option_list: TAMANHO.map((option) => ({ option })) },
      ],
      model: modelos,
      standardise_tier_variation: [
        {
          variation_id: 101054,
          variation_name: 'Cor',
          variation_option_list: COR.map((nome, i) => ({
            variation_option_id: IDS_COR[i] ?? 0,
            variation_option_name: nome,
          })),
        },
        {
          variation_id: 101056,
          variation_name: 'Tamanho',
          variation_group_id: 123,
          variation_option_list: TAMANHO.map((nome, i) => ({
            variation_option_id: IDS_TAMANHO[i] ?? 0,
            variation_option_name: nome,
          })),
        },
      ],
    },
    debug_message: 'envelope verbatim',
  };
}

function leituraDeItem(linha: Obj = {}): Obj {
  return {
    error: '',
    message: '',
    warning: '',
    response: {
      item_list: [
        {
          item_id: 4242,
          category_id: 100001,
          create_time: 1_234_567_890,
          update_time: 1_345_678_901,
          weight: '1.2',
          dimension: { package_length: 10, package_width: 10, package_height: 10 },
          item_status: 'NORMAL',
          tax_info: { ncm: '00000000', origin: '0' },
          ...linha,
        },
      ],
    },
  };
}

/** Typed reads over a neutralised body. */
function resp(corpo: WireValue): Obj {
  return (corpo as Obj).response as Obj;
}
function modelos(corpo: WireValue): Obj[] {
  return resp(corpo).model as Obj[];
}
function opcoesDoTier(corpo: WireValue, t: number): Obj[] {
  return ((resp(corpo).tier_variation as Obj[])[t] as Obj).option_list as Obj[];
}
function opcoesPadrao(corpo: WireValue, t: number): Obj[] {
  return ((resp(corpo).standardise_tier_variation as Obj[])[t] as Obj)
    .variation_option_list as Obj[];
}
function linhaDoItem(corpo: WireValue): Obj {
  return (resp(corpo).item_list as Obj[])[0] as Obj;
}
function estoque(m: Obj): Obj {
  return m.stock_info_v2 as Obj;
}

/** Every key path of a value, in order — what "key order kept" compares. */
function chaves(v: WireValue, prefixo = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((e, i) => chaves(e, `${prefixo}.${String(i)}`));
  if (typeof v === 'object' && v !== null) {
    return Object.entries(v).flatMap(([k, e]) => [
      `${prefixo}.${k}`,
      ...chaves(e, `${prefixo}.${k}`),
    ]);
  }
  return [];
}

/** Every leaf of a value, keyed by its concrete dotted path. */
function folhasPorCaminho(
  v: WireValue,
  caminho: string[] = [],
  achadas = new Map<string, WireValue>(),
) {
  if (Array.isArray(v)) v.forEach((e, i) => folhasPorCaminho(e, [...caminho, String(i)], achadas));
  else if (typeof v === 'object' && v !== null) {
    for (const [k, e] of Object.entries(v)) folhasPorCaminho(e, [...caminho, k], achadas);
  } else achadas.set(caminho.join('.'), v);
  return achadas;
}

/** The leaf paths whose value differs between two bodies, array indices as `*`. */
function caminhosQueMudaram(antes: WireValue, depois: WireValue): string[] {
  const d = folhasPorCaminho(depois);
  return [...folhasPorCaminho(antes)]
    .filter(([caminho, valor]) => !d.has(caminho) || d.get(caminho) !== valor)
    .map(([caminho]) => caminho.replace(/(^|\.)\d+(?=\.|$)/g, '$1*'));
}

describe('neutralizarLeituraDeAnuncio — preços', () => {
  it('as quatro chaves de preço de todo `price_info` viram PRECO_NEUTRO', () => {
    const saida = neutralizarLeituraDeAnuncio(listaDeModelos());
    expect(modelos(saida)).toHaveLength(6);
    for (const m of modelos(saida)) {
      for (const entrada of m.price_info as Obj[]) {
        for (const chave of CHAVES_DE_PRECO) expect(entrada[chave], chave).toBe(PRECO_NEUTRO);
      }
    }
  });

  it('⛔ QUASE-IGUAL: `currency`, `model_id`, `model_sku`, `tier_index`, `weight`, `dimension` e `gtin_code` ficam como estavam', () => {
    const entrada = listaDeModelos();
    const saida = neutralizarLeituraDeAnuncio(entrada);
    modelos(saida).forEach((m, i) => {
      const antes = modelos(entrada)[i] as Obj;
      expect((m.price_info as Obj[])[0]?.currency).toBe('BRL');
      for (const chave of [
        'model_id',
        'model_sku',
        'tier_index',
        'weight',
        'dimension',
        'gtin_code',
        'has_promotion',
        'promotion_id',
      ]) {
        expect(m[chave], chave).toEqual(antes[chave]);
      }
    });
  });

  it('um preço `null` fica `null`; um preço TEXTO é recusado', () => {
    const corpo = listaDeModelos();
    const m0 = modelos(corpo)[0] as Obj;
    (m0.price_info as Obj[])[0] = { current_price: null, currency: 'BRL' };
    const saida = neutralizarLeituraDeAnuncio(corpo);
    expect((modelos(saida)[0]?.price_info as Obj[])[0]).toEqual({
      current_price: null,
      currency: 'BRL',
    });

    (m0.price_info as Obj[])[0] = { current_price: '37.50', currency: 'BRL' };
    expect(() => neutralizarLeituraDeAnuncio(corpo)).toThrow(ErroDeNeutralizacao);
  });
});

describe('neutralizarLeituraDeAnuncio — estoque', () => {
  it('toda contagem POSITIVA vira ESTOQUE_NEUTRO — reservado, disponível, vendedor e antecipado', () => {
    const saida = neutralizarLeituraDeAnuncio(listaDeModelos());
    const m0 = modelos(saida)[0] as Obj;
    expect((estoque(m0).summary_info as Obj).total_reserved_stock).toBe(ESTOQUE_NEUTRO);
    expect((estoque(m0).summary_info as Obj).total_available_stock).toBe(ESTOQUE_NEUTRO);
    expect((estoque(m0).seller_stock as Obj[])[0]?.stock).toBe(ESTOQUE_NEUTRO);
    expect((estoque(m0).advance_stock as Obj).sellable_advance_stock).toBe(ESTOQUE_NEUTRO);
  });

  it('⛔ QUASE-IGUAL: um `0` fica `0` — esgotado continua esgotado', () => {
    const saida = neutralizarLeituraDeAnuncio(listaDeModelos());
    // The Azul models (cor 1) were built sold out.
    const esgotados = modelos(saida).filter((m) => (m.tier_index as number[])[0] === 1);
    expect(esgotados).toHaveLength(2);
    for (const m of esgotados) {
      expect((estoque(m).summary_info as Obj).total_available_stock).toBe(0);
      expect((estoque(m).seller_stock as Obj[])[0]?.stock).toBe(0);
    }
    for (const m of modelos(saida)) {
      expect((estoque(m).shopee_stock as Obj[])[0]?.stock).toBe(0);
      expect((estoque(m).advance_stock as Obj).in_transit_advance_stock).toBe(0);
      expect((estoque(m).seller_stock as Obj[])[0]?.location_id).toBe('LOCAL-INVENTADO');
    }
  });

  it('uma contagem NEGATIVA é recusada', () => {
    const corpo = listaDeModelos();
    ((estoque(modelos(corpo)[0] as Obj).seller_stock as Obj[])[0] as Obj).stock = -1;
    expect(() => neutralizarLeituraDeAnuncio(corpo)).toThrow(ErroDeNeutralizacao);
  });
});

describe('neutralizarLeituraDeAnuncio — todo local, toda linha, toda entrada', () => {
  it('`shopee_stock` e `in_transit_advance_stock` POSITIVOS viram ESTOQUE_NEUTRO', () => {
    const corpo = listaDeModelos();
    const e0 = estoque(modelos(corpo)[0] as Obj);
    e0.shopee_stock = [{ location_id: '', stock: 4 }];
    e0.advance_stock = { sellable_advance_stock: 3, in_transit_advance_stock: 7 };
    const s0 = estoque(modelos(neutralizarLeituraDeAnuncio(corpo))[0] as Obj);
    expect((s0.shopee_stock as Obj[])[0]?.stock).toBe(ESTOQUE_NEUTRO);
    expect((s0.advance_stock as Obj).in_transit_advance_stock).toBe(ESTOQUE_NEUTRO);
  });

  it('⛔ QUASE-IGUAL: um `1` é positivo — vira ESTOQUE_NEUTRO; só o `0` fica', () => {
    const corpo = listaDeModelos();
    const e0 = estoque(modelos(corpo)[0] as Obj);
    e0.summary_info = { total_reserved_stock: 0, total_available_stock: 1 };
    e0.seller_stock = [{ location_id: 'LOCAL-INVENTADO', stock: 1, if_saleable: true }];
    const s0 = estoque(modelos(neutralizarLeituraDeAnuncio(corpo))[0] as Obj);
    expect(s0.summary_info).toEqual({
      total_reserved_stock: 0,
      total_available_stock: ESTOQUE_NEUTRO,
    });
    expect((s0.seller_stock as Obj[])[0]?.stock).toBe(ESTOQUE_NEUTRO);
  });

  it('TODA linha de `seller_stock` e de `shopee_stock` é neutralizada, não só a primeira', () => {
    const corpo = listaDeModelos();
    const e0 = estoque(modelos(corpo)[0] as Obj);
    e0.seller_stock = [
      { location_id: 'LOCAL-INVENTADO', stock: 6, if_saleable: true },
      { location_id: 'LOCAL-INVENTADO-2', stock: 2, if_saleable: true },
    ];
    e0.shopee_stock = [
      { location_id: '', stock: 0 },
      { location_id: 'OUTRO-INVENTADO', stock: 5 },
    ];
    const s0 = estoque(modelos(neutralizarLeituraDeAnuncio(corpo))[0] as Obj);
    expect((s0.seller_stock as Obj[]).map((l) => l.stock)).toEqual([
      ESTOQUE_NEUTRO,
      ESTOQUE_NEUTRO,
    ]);
    expect((s0.shopee_stock as Obj[]).map((l) => l.stock)).toEqual([0, ESTOQUE_NEUTRO]);
  });

  it('as quatro chaves de preço viram PRECO_NEUTRO em TODA entrada de `price_info`, não só na primeira', () => {
    const corpo = listaDeModelos();
    (modelos(corpo)[0]?.price_info as Obj[]).push({
      current_price: 12.3,
      original_price: 14.5,
      inflated_price_of_current_price: 13.1,
      inflated_price_of_original_price: 15.7,
      currency: 'BRL',
    });
    const entradas = modelos(neutralizarLeituraDeAnuncio(corpo))[0]?.price_info as Obj[];
    expect(entradas).toHaveLength(2);
    for (const entrada of entradas) {
      for (const chave of CHAVES_DE_PRECO) expect(entrada[chave], chave).toBe(PRECO_NEUTRO);
    }
  });

  it('`create_time` e `update_time` viram as constantes em TODA linha de `item_list`, não só na primeira', () => {
    const corpo = leituraDeItem();
    (resp(corpo).item_list as Obj[]).push({
      item_id: 4343,
      create_time: 1_111_111_111,
      update_time: 1_222_222_222,
    });
    const linhas = resp(neutralizarLeituraDeAnuncio(corpo)).item_list as Obj[];
    expect(linhas.map((l) => [l.create_time, l.update_time])).toEqual([
      [CRIACAO_NEUTRA, ATUALIZACAO_NEUTRA],
      [CRIACAO_NEUTRA, ATUALIZACAO_NEUTRA],
    ]);
  });

  it('⛔ QUASE-IGUAL: a ordem das chaves é a do wire — `currency` continua por ÚLTIMO em `price_info`', () => {
    const corpo = listaDeModelos();
    const ultima = (m: Obj): string | undefined =>
      Object.keys((m.price_info as Obj[])[0] as Obj).at(-1);
    // The wire's own order — the four prices first, `currency` LAST — so a
    // transform that re-inserts a price moves it after `currency`.
    expect(modelos(corpo).map(ultima)).toEqual(modelos(corpo).map(() => 'currency'));
    const saida = neutralizarLeituraDeAnuncio(corpo);
    expect(modelos(saida).map(ultima)).toEqual(modelos(saida).map(() => 'currency'));
    expect(chaves(saida)).toEqual(chaves(corpo));
  });
});

describe('neutralizarLeituraDeAnuncio — datas do anúncio', () => {
  it('`create_time` e `update_time` viram as constantes neutras (segundos, criação antes da atualização)', () => {
    const saida = neutralizarLeituraDeAnuncio(leituraDeItem());
    expect(linhaDoItem(saida).create_time).toBe(CRIACAO_NEUTRA);
    expect(linhaDoItem(saida).update_time).toBe(ATUALIZACAO_NEUTRA);
    expect(CRIACAO_NEUTRA).toBeLessThan(ATUALIZACAO_NEUTRA);
    // Seconds, like the wire: ten digits, never milliseconds.
    expect(String(ATUALIZACAO_NEUTRA)).toHaveLength(10);
  });

  it('⛔ QUASE-IGUAL: uma data AUSENTE continua ausente, e o resto da linha fica como estava', () => {
    const entrada = leituraDeItem();
    delete (linhaDoItem(entrada) as Record<string, unknown>).update_time;
    const saida = neutralizarLeituraDeAnuncio(entrada);
    expect('update_time' in linhaDoItem(saida)).toBe(false);
    expect(linhaDoItem(saida).create_time).toBe(CRIACAO_NEUTRA);
    for (const chave of [
      'item_id',
      'category_id',
      'item_status',
      'weight',
      'dimension',
      'tax_info',
    ]) {
      expect(linhaDoItem(saida)[chave], chave).toEqual(linhaDoItem(entrada)[chave]);
    }
  });

  it('uma data que não é número é recusada — `null` e texto', () => {
    expect(() => neutralizarLeituraDeAnuncio(leituraDeItem({ create_time: null }))).toThrow(
      ErroDeNeutralizacao,
    );
    expect(() =>
      neutralizarLeituraDeAnuncio(leituraDeItem({ update_time: '2024-01-01T00:00:00Z' })),
    ).toThrow(ErroDeNeutralizacao);
  });
});

describe('neutralizarLeituraDeAnuncio — opções digitadas pelo vendedor', () => {
  it('a opção de id 0 vira `Opção inventada 1` nos TRÊS lugares: a opção do tier, a padronizada e todo `model_name`', () => {
    const saida = neutralizarLeituraDeAnuncio(listaDeModelos());
    const novo = `${PREFIXO_OPCAO_INVENTADA}1`;
    expect(novo).toBe('Opção inventada 1');
    expect(opcoesDoTier(saida, 0)[2]?.option).toBe(novo);
    expect(opcoesPadrao(saida, 0)[2]?.variation_option_name).toBe(novo);
    expect(opcoesPadrao(saida, 0)[2]?.variation_option_id).toBe(0);
    const daOpcao = modelos(saida).filter((m) => (m.tier_index as number[])[0] === 2);
    expect(daOpcao.map((m) => m.model_name)).toEqual([`${novo},P`, `${novo},G`]);
    // No model_name anywhere still spells the seller's text.
    expect(modelos(saida).filter((m) => String(m.model_name).includes(COR[2]))).toHaveLength(0);
    // Every model_name is the join of its (renamed) tier options.
    for (const m of modelos(saida)) {
      const [c, t] = m.tier_index as [number, number];
      expect(m.model_name).toBe(
        `${String(opcoesDoTier(saida, 0)[c]?.option)},${String(opcoesDoTier(saida, 1)[t]?.option)}`,
      );
    }
  });

  it('⛔ QUASE-IGUAL: as opções PADRÃO (id ≠ 0) guardam o nome — no tier, na lista padronizada e no `model_name`', () => {
    const saida = neutralizarLeituraDeAnuncio(listaDeModelos());
    expect(
      opcoesDoTier(saida, 0)
        .slice(0, 2)
        .map((o) => o.option),
    ).toEqual(['Vermelho', 'Azul']);
    expect(opcoesDoTier(saida, 1).map((o) => o.option)).toEqual(['P', 'G']);
    expect(
      opcoesPadrao(saida, 0)
        .slice(0, 2)
        .map((o) => o.variation_option_name),
    ).toEqual(['Vermelho', 'Azul']);
    expect(opcoesPadrao(saida, 1).map((o) => o.variation_option_name)).toEqual(['P', 'G']);
    expect(modelos(saida)[0]?.model_name).toBe('Vermelho,P');
    // The image placeholders and the tier names are untouched.
    expect(opcoesDoTier(saida, 0)[2]?.image).toEqual({
      image_id: 'imagem-redigida',
      image_url: 'https://redacted.invalid/imagem',
    });
    expect((resp(saida).tier_variation as Obj[]).map((t) => t.name)).toEqual(['Cor', 'Tamanho']);
  });

  it('⛔ QUASE-IGUAL: o par é por ÍNDICE — uma opção padrão cuja grafia padronizada difere da do tier continua padrão', () => {
    const corpo = listaDeModelos();
    // Shopee's standardised spelling of option 0 differs from the tier's; the
    // id is non-zero, so it is STANDARD whatever the names say.
    (opcoesPadrao(corpo, 0)[0] as Obj).variation_option_name = 'VERMELHO';
    const saida = neutralizarLeituraDeAnuncio(corpo);
    expect(opcoesDoTier(saida, 0)[0]?.option).toBe('Vermelho');
    expect(opcoesPadrao(saida, 0)[0]?.variation_option_name).toBe('VERMELHO');
    expect(opcoesDoTier(saida, 0)[2]?.option).toBe(`${PREFIXO_OPCAO_INVENTADA}1`);
  });

  it('⛔ QUASE-IGUAL: a gêmea padronizada VAZIA, só de espaços ou AUSENTE não ganha nome — só a opção do tier é renomeada', () => {
    for (const gemea of ['', '  ']) {
      const corpo = listaDeModelos();
      (opcoesPadrao(corpo, 0)[2] as Obj).variation_option_name = gemea;
      const saida = neutralizarLeituraDeAnuncio(corpo);
      expect(opcoesDoTier(saida, 0)[2]?.option).toBe(`${PREFIXO_OPCAO_INVENTADA}1`);
      expect(opcoesPadrao(saida, 0)[2]?.variation_option_name).toBe(gemea);
    }

    const semNome = listaDeModelos();
    delete (opcoesPadrao(semNome, 0)[2] as Record<string, unknown>).variation_option_name;
    const saida = neutralizarLeituraDeAnuncio(semNome);
    expect(opcoesDoTier(saida, 0)[2]?.option).toBe(`${PREFIXO_OPCAO_INVENTADA}1`);
    expect('variation_option_name' in (opcoesPadrao(saida, 0)[2] as Obj)).toBe(false);
  });

  it('um tier SEM variação padrão — sem entrada, ou `variation_id` 0 — tem TODAS as opções renomeadas, na ordem tier → opção', () => {
    const semEntrada = listaDeModelos();
    // Tier 1 loses its standardised entry: every Tamanho option is the seller's.
    (resp(semEntrada).standardise_tier_variation as Obj[]).pop();
    const a = neutralizarLeituraDeAnuncio(semEntrada);
    expect(opcoesDoTier(a, 0).map((o) => o.option)).toEqual([
      'Vermelho',
      'Azul',
      'Opção inventada 1',
    ]);
    expect(opcoesDoTier(a, 1).map((o) => o.option)).toEqual([
      'Opção inventada 2',
      'Opção inventada 3',
    ]);
    expect(modelos(a)[0]?.model_name).toBe('Vermelho,Opção inventada 2');
    expect(modelos(a)[5]?.model_name).toBe('Opção inventada 1,Opção inventada 3');

    const idZero = listaDeModelos();
    // Tier 0 is custom (variation_id 0) — even its non-zero option ids do not
    // make an option standard, and its standardised names go with the options.
    ((resp(idZero).standardise_tier_variation as Obj[])[0] as Obj).variation_id = 0;
    const b = neutralizarLeituraDeAnuncio(idZero);
    expect(opcoesDoTier(b, 0).map((o) => o.option)).toEqual([
      'Opção inventada 1',
      'Opção inventada 2',
      'Opção inventada 3',
    ]);
    expect(opcoesPadrao(b, 0).map((o) => o.variation_option_name)).toEqual([
      'Opção inventada 1',
      'Opção inventada 2',
      'Opção inventada 3',
    ]);
    expect(opcoesDoTier(b, 1).map((o) => o.option)).toEqual(['P', 'G']);
  });

  it('uma lista de modelos SEM opção do vendedor não muda nome nenhum', () => {
    const corpo = listaDeModelos();
    (opcoesPadrao(corpo, 0)[2] as Obj).variation_option_id = 7003;
    const saida = neutralizarLeituraDeAnuncio(corpo);
    expect(opcoesDoTier(saida, 0).map((o) => o.option)).toEqual([...COR]);
    expect(modelos(saida).map((m) => m.model_name)).toEqual(
      modelos(corpo).map((m) => m.model_name),
    );
  });
});

describe('neutralizarLeituraDeAnuncio — árvores de variação AUSENTES', () => {
  it('sem `standardise_tier_variation` (ausente ou `null`), TODA opção é do vendedor — renomeada, e todo `model_name` refeito', () => {
    for (const forma of ['ausente', 'null'] as const) {
      const corpo = listaDeModelos();
      if (forma === 'ausente') {
        delete (resp(corpo) as Record<string, unknown>).standardise_tier_variation;
      } else {
        resp(corpo).standardise_tier_variation = null;
      }
      const saida = neutralizarLeituraDeAnuncio(corpo);
      expect(
        opcoesDoTier(saida, 0).map((o) => o.option),
        forma,
      ).toEqual(['Opção inventada 1', 'Opção inventada 2', 'Opção inventada 3']);
      expect(
        opcoesDoTier(saida, 1).map((o) => o.option),
        forma,
      ).toEqual(['Opção inventada 4', 'Opção inventada 5']);
      expect(modelos(saida)[0]?.model_name, forma).toBe('Opção inventada 1,Opção inventada 4');
      expect(modelos(saida)[5]?.model_name, forma).toBe('Opção inventada 3,Opção inventada 5');
    }
  });

  it('sem `tier_variation` (ausente ou `null`) é ZERO tiers — uma variação padronizada, ou um modelo com tier, é recusado', () => {
    for (const forma of ['ausente', 'null'] as const) {
      const comPadronizada = listaDeModelos();
      const semNenhuma = listaDeModelos();
      for (const corpo of [comPadronizada, semNenhuma]) {
        if (forma === 'ausente') delete (resp(corpo) as Record<string, unknown>).tier_variation;
        else resp(corpo).tier_variation = null;
      }
      // Both trees gone: the models still carry a `tier_index` no tier explains.
      if (forma === 'ausente') {
        delete (resp(semNenhuma) as Record<string, unknown>).standardise_tier_variation;
      } else {
        resp(semNenhuma).standardise_tier_variation = null;
      }
      expect(() => neutralizarLeituraDeAnuncio(comPadronizada), forma).toThrow(ErroDeNeutralizacao);
      expect(() => neutralizarLeituraDeAnuncio(semNenhuma), forma).toThrow(ErroDeNeutralizacao);
    }
  });

  it('⛔ QUASE-IGUAL: sem árvore nenhuma, uma lista SEM modelos passa sem mudança, e modelos SEM tier só têm preço e estoque neutralizados', () => {
    const vazia = listaDeModelos();
    delete (resp(vazia) as Record<string, unknown>).tier_variation;
    delete (resp(vazia) as Record<string, unknown>).standardise_tier_variation;
    resp(vazia).model = [];
    expect(isDeepStrictEqual(neutralizarLeituraDeAnuncio(vazia), vazia)).toBe(true);

    const semTier = listaDeModelos();
    delete (resp(semTier) as Record<string, unknown>).tier_variation;
    delete (resp(semTier) as Record<string, unknown>).standardise_tier_variation;
    resp(semTier).model = [{ ...modelo(0, 0, 5), model_name: '', tier_index: [] }];
    const saida = neutralizarLeituraDeAnuncio(semTier);
    const m0 = modelos(saida)[0] as Obj;
    expect(m0.model_name).toBe('');
    expect((m0.price_info as Obj[])[0]?.current_price).toBe(PRECO_NEUTRO);
    expect((estoque(m0).seller_stock as Obj[])[0]?.stock).toBe(ESTOQUE_NEUTRO);
  });
});

describe('neutralizarLeituraDeAnuncio — recusas (falha FECHADA)', () => {
  it('listas de opções de tamanhos diferentes no mesmo tier', () => {
    const corpo = listaDeModelos();
    opcoesPadrao(corpo, 1).pop();
    expect(() => neutralizarLeituraDeAnuncio(corpo)).toThrow(ErroDeNeutralizacao);
  });

  it('uma lista padronizada MAIS LONGA que a de opções num tier PADRÃO (a sobra seria commitada sem par)', () => {
    const corpo = listaDeModelos();
    opcoesPadrao(corpo, 0).push({
      variation_option_id: 0,
      variation_option_name: 'Sobra Inventada',
    });
    expect(() => neutralizarLeituraDeAnuncio(corpo)).toThrow(ErroDeNeutralizacao);
  });

  it('um tier SEM variação padrão (`variation_id` 0) cuja lista padronizada difere em tamanho — mais LONGA ou mais CURTA', () => {
    const maisLonga = listaDeModelos();
    ((resp(maisLonga).standardise_tier_variation as Obj[])[0] as Obj).variation_id = 0;
    opcoesPadrao(maisLonga, 0).push({
      variation_option_id: 0,
      variation_option_name: 'Sobra Inventada',
    });
    expect(() => neutralizarLeituraDeAnuncio(maisLonga)).toThrow(ErroDeNeutralizacao);

    const maisCurta = listaDeModelos();
    ((resp(maisCurta).standardise_tier_variation as Obj[])[0] as Obj).variation_id = 0;
    opcoesPadrao(maisCurta, 0).pop();
    expect(() => neutralizarLeituraDeAnuncio(maisCurta)).toThrow(ErroDeNeutralizacao);
  });

  it('um `model_name` que não é a junção das opções do seu `tier_index`', () => {
    const corpo = listaDeModelos();
    (modelos(corpo)[3] as Obj).model_name = 'Azul, G';
    expect(() => neutralizarLeituraDeAnuncio(corpo)).toThrow(ErroDeNeutralizacao);
  });

  it('um `model_name` que não é a junção é recusado MESMO sem opção do vendedor', () => {
    const corpo = listaDeModelos();
    (opcoesPadrao(corpo, 0)[2] as Obj).variation_option_id = 7003;
    (modelos(corpo)[0] as Obj).model_name = 'Texto Livre Inventado';
    expect(() => neutralizarLeituraDeAnuncio(corpo)).toThrow(ErroDeNeutralizacao);
  });

  it('um `tier_index` que não aponta para nenhuma opção', () => {
    const corpo = listaDeModelos();
    (modelos(corpo)[0] as Obj).tier_index = [0, 9];
    expect(() => neutralizarLeituraDeAnuncio(corpo)).toThrow(ErroDeNeutralizacao);
  });

  it('um `tier_index` fora do alcance é recusado MESMO quando o `model_name` coincide com a junção que o pularia', () => {
    const corpo = listaDeModelos();
    const m0 = modelos(corpo)[0] as Obj;
    m0.tier_index = [0, 9];
    m0.model_name = 'Vermelho,';
    expect(() => neutralizarLeituraDeAnuncio(corpo)).toThrow(ErroDeNeutralizacao);
  });

  it("uma opção do vendedor com ',' no nome", () => {
    const corpo = listaDeModelos();
    const comVirgula = 'Tom, Livre';
    (opcoesDoTier(corpo, 0)[2] as Obj).option = comVirgula;
    (opcoesPadrao(corpo, 0)[2] as Obj).variation_option_name = comVirgula;
    // Rebuild the model names so ONLY the comma is wrong with this body.
    for (const m of modelos(corpo)) {
      const [c, t] = m.tier_index as [number, number];
      m.model_name = `${c === 2 ? comVirgula : (COR[c] ?? '')},${TAMANHO[t] ?? ''}`;
    }
    expect(() => neutralizarLeituraDeAnuncio(corpo)).toThrow(ErroDeNeutralizacao);
  });

  it('uma opção do vendedor cuja gêmea padronizada traz OUTRO nome não vazio', () => {
    const corpo = listaDeModelos();
    (opcoesPadrao(corpo, 0)[2] as Obj).variation_option_name = 'Outro Texto Inventado';
    expect(() => neutralizarLeituraDeAnuncio(corpo)).toThrow(ErroDeNeutralizacao);
  });

  it('uma lista padronizada MAIS LONGA que a de tiers', () => {
    const corpo = listaDeModelos();
    (resp(corpo).standardise_tier_variation as Obj[]).push({
      variation_id: 101099,
      variation_name: 'Sobra',
      variation_option_list: [],
    });
    expect(() => neutralizarLeituraDeAnuncio(corpo)).toThrow(ErroDeNeutralizacao);
  });

  it('uma chave de LISTA que não é lista — `price_info`, `seller_stock`, `item_list`, `tier_variation`, `option_list`', () => {
    const precos = listaDeModelos();
    (modelos(precos)[0] as Obj).price_info = { current_price: 37.5, currency: 'BRL' };
    const vendedor = listaDeModelos();
    estoque(modelos(vendedor)[0] as Obj).seller_stock = { stock: 5 };
    const itens = leituraDeItem();
    resp(itens).item_list = { item_id: 4242, create_time: 1_234_567_890 };
    // The two tier cases carry no standardised entry and no model, so no OTHER
    // refusal (a standardised list longer than the tiers, a length mismatch, a
    // model_name that is not the join) can throw in the list check's place.
    const tiers = listaDeModelos();
    resp(tiers).tier_variation = { name: 'Cor', option_list: [] };
    resp(tiers).standardise_tier_variation = [];
    resp(tiers).model = [];
    const opcoes = listaDeModelos();
    ((resp(opcoes).tier_variation as Obj[])[0] as Obj).option_list = { option: 'Vermelho' };
    resp(opcoes).standardise_tier_variation = [];
    resp(opcoes).model = [];
    const casos = { precos, vendedor, itens, tiers, opcoes };
    for (const [nome, corpo] of Object.entries(casos)) {
      expect(() => neutralizarLeituraDeAnuncio(corpo), nome).toThrow(ErroDeNeutralizacao);
    }
  });

  it('uma chave de OBJETO que não é objeto — `stock_info_v2` lista, `summary_info` e `advance_stock` número', () => {
    const lista = listaDeModelos();
    (modelos(lista)[0] as Obj).stock_info_v2 = [{ summary_info: { total_available_stock: 5 } }];
    const resumo = listaDeModelos();
    estoque(modelos(resumo)[0] as Obj).summary_info = 5;
    const antecipado = listaDeModelos();
    estoque(modelos(antecipado)[0] as Obj).advance_stock = 3;
    for (const [nome, corpo] of Object.entries({ lista, resumo, antecipado })) {
      expect(() => neutralizarLeituraDeAnuncio(corpo), nome).toThrow(ErroDeNeutralizacao);
    }
  });

  it('uma ENTRADA de lista que não é objeto — `item_list: [7]`, `price_info: [37.5]`', () => {
    const itens = leituraDeItem();
    resp(itens).item_list = [7];
    const precos = listaDeModelos();
    (modelos(precos)[0] as Obj).price_info = [37.5];
    for (const [nome, corpo] of Object.entries({ itens, precos })) {
      expect(() => neutralizarLeituraDeAnuncio(corpo), nome).toThrow(ErroDeNeutralizacao);
    }
  });

  it('uma opção do vendedor cujo nome não é TEXTO (nenhum modelo a usa, então só a renomeação a vê)', () => {
    const corpo = listaDeModelos();
    (opcoesDoTier(corpo, 0)[2] as Obj).option = 77;
    resp(corpo).model = modelos(corpo).filter((m) => (m.tier_index as number[])[0] !== 2);
    expect(() => neutralizarLeituraDeAnuncio(corpo)).toThrow(ErroDeNeutralizacao);
  });
});

describe('neutralizarLeituraDeAnuncio — pureza', () => {
  it('é IDEMPOTENTE: neutralizar duas vezes é neutralizar uma vez', () => {
    for (const corpo of [listaDeModelos(), leituraDeItem()]) {
      const uma = neutralizarLeituraDeAnuncio(corpo);
      const duas = neutralizarLeituraDeAnuncio(uma);
      expect(duas).toEqual(uma);
    }
  });

  it('a numeração RECOMEÇA em 1 a cada chamada — nada sobrevive entre chamadas', () => {
    const a = neutralizarLeituraDeAnuncio(listaDeModelos());
    const b = neutralizarLeituraDeAnuncio(listaDeModelos());
    expect(opcoesDoTier(a, 0)[2]?.option).toBe('Opção inventada 1');
    expect(opcoesDoTier(b, 0)[2]?.option).toBe('Opção inventada 1');
    expect(b).toEqual(a);
  });

  it('não muda a entrada e devolve um valor NOVO, com as chaves na mesma ordem', () => {
    for (const corpo of [listaDeModelos(), leituraDeItem()]) {
      const copia = structuredClone(corpo);
      const saida = neutralizarLeituraDeAnuncio(corpo);
      expect(corpo).toEqual(copia);
      expect(saida).not.toBe(corpo);
      expect(chaves(saida)).toEqual(chaves(corpo));
    }
  });

  it('um corpo de OUTRA forma passa sem mudança — categoria, erro, árvore de atributos, pedido, não-objetos', () => {
    const outros: WireValue[] = [
      { error: 'error_not_found' },
      {
        error: '',
        response: {
          category_list: [{ category_id: 1, parent_category_id: 0, has_children: false }],
        },
      },
      { response: { list: [{ category_id: 1, attribute_tree: [] }] } },
      {
        response: {
          order_list: [{ order_sn: 'INVENTADO', create_time: 1_111_111_111, item_list: [] }],
        },
      },
      { response: null },
      null,
      [1, 2, 3],
      'texto',
    ];
    for (const corpo of outros) {
      expect(isDeepStrictEqual(neutralizarLeituraDeAnuncio(corpo), corpo)).toBe(true);
    }
  });

  it('CAMPOS_NEUTRALIZADOS é EXATAMENTE o que muda — toda entrada é substituída num corpo que a traz, e nada além delas', () => {
    // Every documented key present and POSITIVE, and one seller-typed option.
    const lista: Obj = {
      error: '',
      message: '',
      warning: '',
      response: {
        tier_variation: [{ name: 'Cor', option_list: [{ option: 'Tom Inventado' }] }],
        model: [
          {
            model_id: 901,
            model_name: 'Tom Inventado',
            promotion_id: 0,
            has_promotion: false,
            tier_index: [0],
            price_info: [
              {
                current_price: 12.5,
                original_price: 13.5,
                inflated_price_of_current_price: 14.5,
                inflated_price_of_original_price: 15.5,
                currency: 'BRL',
              },
            ],
            model_sku: 'SKU-00000009',
            stock_info_v2: {
              summary_info: { total_reserved_stock: 1, total_available_stock: 4 },
              seller_stock: [{ location_id: 'LOCAL-INVENTADO', stock: 3, if_saleable: true }],
              shopee_stock: [{ location_id: 'OUTRO-INVENTADO', stock: 2 }],
              advance_stock: { sellable_advance_stock: 5, in_transit_advance_stock: 6 },
            },
            weight: '0.35',
          },
        ],
        standardise_tier_variation: [
          {
            variation_id: 101054,
            variation_name: 'Cor',
            variation_option_list: [
              { variation_option_id: 0, variation_option_name: 'Tom Inventado' },
            ],
          },
        ],
      },
    };
    const mudadas = new Set(
      [leituraDeItem(), lista].flatMap((corpo) =>
        caminhosQueMudaram(corpo, neutralizarLeituraDeAnuncio(corpo)),
      ),
    );
    // The list's own annotations (" (seller-typed options only)") are prose.
    const documentadas = new Set(CAMPOS_NEUTRALIZADOS.map((c) => c.replace(/ \(.*\)$/, '')));
    expect(documentadas.size).toBe(CAMPOS_NEUTRALIZADOS.length);
    expect([...mudadas].sort()).toEqual([...documentadas].sort());
  });
});
