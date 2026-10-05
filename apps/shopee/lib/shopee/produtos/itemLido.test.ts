import { describe, expect, it } from 'vitest';

import {
  type ShopeeItemBaseInfo,
  type ShopeeModelList,
  shopeeItemBaseInfoPayloadSchema,
  shopeeModelListPayloadSchema,
} from '@delfrance/integrations-shopee';

import {
  campoAninhadoDe,
  descricaoDe,
  ehKitDe,
  itemStatusDe,
  montarItemLido,
  taxInfoDe,
  tiersDe,
  tiersPadronizadosDe,
  temModelosDe,
} from './itemLido';

/* -------------------------------------------------------------------------- */
/*  Fixtures — ids de fixture, nunca reais.                                    */
/* -------------------------------------------------------------------------- */

const ITEM_ID = 2_500_139_861;
const OUTRO_ITEM_ID = 2_500_139_862;
const MODEL_ID = 2_000_458_802;

/** O bloco fiscal, reduzido ao que o teste observa. */
const TAX_ITEM = { ncm: '61091000', csosn: '500' };
const TAX_RAIZ = { ncm: '00000000', csosn: '102' };

/** Parse pelo schema do pacote: os `.default(null)` entram como entrariam no wire. */
function payload(bruto: Record<string, unknown>): ShopeeItemBaseInfo {
  return shopeeItemBaseInfoPayloadSchema.parse(bruto);
}

function comUmItem(item: Record<string, unknown>, raiz: Record<string, unknown> = {}) {
  return payload({ item_list: [{ item_id: ITEM_ID, ...item }], ...raiz });
}

function modelos(bruto: Record<string, unknown>): ShopeeModelList {
  return shopeeModelListPayloadSchema.parse(bruto);
}

/* -------------------------------------------------------------------------- */
/*  As cinco chaves que a Shopee aninha em DOIS lugares                        */
/* -------------------------------------------------------------------------- */

describe('taxInfoDe / campoAninhadoDe', () => {
  it('1. lê tax_info na posição do SAMPLE (dentro do item)', () => {
    const p = comUmItem({ tax_info: TAX_ITEM });
    const item = montarItemLido({ itemId: ITEM_ID, payload: p });
    expect(item.taxInfo?.ncm).toBe('61091000');
    expect(item.base.tax_info?.csosn).toBe('500');
  });

  it('2. lê tax_info na posição da TABELA (irmão de item_list, na raiz)', () => {
    const p = comUmItem({}, { tax_info: TAX_RAIZ });
    const item = montarItemLido({ itemId: ITEM_ID, payload: p });
    // ⚠️ É esta a leitura que, declarada num lugar só, faria TODO item chegar
    // com o bloco fiscal nulo — sem erro nenhum, em lugar nenhum.
    expect(item.taxInfo?.ncm).toBe('00000000');
    expect(item.base.tax_info?.ncm).toBe('00000000');
  });

  it('3. prefere a posição INTERNA quando as duas existem', () => {
    const p = comUmItem({ tax_info: TAX_ITEM }, { tax_info: TAX_RAIZ });
    expect(taxInfoDe(p, p.item_list[0]!)?.ncm).toBe('61091000');
  });

  it('4. ausente nas duas posições fica null, nunca {}', () => {
    const p = comUmItem({});
    const item = montarItemLido({ itemId: ITEM_ID, payload: p });
    expect(item.taxInfo).toBeNull();
    // Um objeto vazio é uma AFIRMAÇÃO ("a Shopee respondeu, e o bloco é vazio");
    // `null` é outra ("não chegou nada"), e a perna fiscal decide pela diferença.
    expect(item.taxInfo).not.toEqual({});
  });

  it('5. as CINCO chaves ambíguas passam pelo MESMO leitor', () => {
    const p = comUmItem(
      { tax_info: TAX_ITEM },
      {
        description_type: 'normal',
        description_info: { extended_description: { field_list: [] } },
        stock_info_v2: { summary_info: { total_available_stock: 7 } },
        complaint_policy: { days_to_complaint: 3 },
      },
    );
    const linha = p.item_list[0]!;
    expect(campoAninhadoDe(p, linha, 'tax_info')?.ncm).toBe('61091000');
    expect(campoAninhadoDe(p, linha, 'description_type')).toBe('normal');
    expect(campoAninhadoDe(p, linha, 'description_info')).not.toBeNull();
    expect(campoAninhadoDe(p, linha, 'stock_info_v2')).not.toBeNull();
    expect(campoAninhadoDe(p, linha, 'complaint_policy')).not.toBeNull();

    // E o registro montado já traz as cinco NORMALIZADAS na posição do item, de
    // modo que ninguém a jusante possa escolher a posição errada.
    const item = montarItemLido({ itemId: ITEM_ID, payload: p });
    expect(item.base.description_type).toBe('normal');
    expect(item.base.stock_info_v2).not.toBeNull();
    expect(item.base.complaint_policy).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  Reconciliação                                                              */
/* -------------------------------------------------------------------------- */

describe('montarItemLido — reconciliação', () => {
  it('6. reconcilia por item_id, nunca por posição', () => {
    const p = payload({
      item_list: [
        { item_id: OUTRO_ITEM_ID, item_name: 'outro' },
        { item_id: ITEM_ID, item_name: 'o pedido' },
      ],
    });
    const item = montarItemLido({ itemId: ITEM_ID, payload: p });
    expect(item.base.item_id).toBe(ITEM_ID);
    expect(item.base.item_name).toBe('o pedido');
    expect(item.itemId).toBe(ITEM_ID);
  });

  it('7. um payload SEM a linha pedida é bug do chamador: Error simples nomeando o id', () => {
    const p = payload({ item_list: [{ item_id: OUTRO_ITEM_ID }] });
    // ⚠️ Não é um ShopeeError: "a linha não voltou" é veredito do JOB
    // (`item-nao-retornado`), que compara os ids pedidos com os recebidos ANTES
    // de montar nada. Um ShopeeError aqui deixaria este bug virar uma falha de
    // anúncio na planilha do operador.
    expect(() => montarItemLido({ itemId: ITEM_ID, payload: p })).toThrow(String(ITEM_ID));
    expect(() => montarItemLido({ itemId: ITEM_ID, payload: p })).toThrow(Error);
  });
});

/* -------------------------------------------------------------------------- */
/*  Acessores                                                                  */
/* -------------------------------------------------------------------------- */

describe('ehKitDe', () => {
  it('8. cai na linha da VARREDURA quando get_item_base_info não traz tag', () => {
    const p = comUmItem({});
    const item = montarItemLido({ itemId: ITEM_ID, payload: p });
    expect(ehKitDe(item.base, { tag: { kit: true } })).toBe(true);
    // E a posição do item ganha quando as duas trazem `tag`.
    const comTag = montarItemLido({ itemId: ITEM_ID, payload: comUmItem({ tag: { kit: false } }) });
    expect(ehKitDe(comTag.base, { tag: { kit: true } })).toBe(false);
  });

  it('9. um item sem tag em NENHUMA das leituras não é kit', () => {
    const item = montarItemLido({ itemId: ITEM_ID, payload: comUmItem({}) });
    expect(ehKitDe(item.base)).toBe(false);
    expect(ehKitDe(item.base, null)).toBe(false);
    expect(ehKitDe(item.base, { tag: null })).toBe(false);
  });
});

describe('temModelosDe', () => {
  it('10. ⛔ NEAR-MISS: has_model como string "false" NÃO é ter modelos', () => {
    // (a) A string nem chega aqui: o schema do pacote DESCARTA a linha inteira —
    // `item_list` é tolerante por ELEMENTO, então a linha ruim vira o sentinela
    // `null` (a página não é perdida pelos outros 49 itens do lote) e NADA dela
    // fica legível. Montar o item a partir desse payload é o erro de chamador que
    // o job traduz em `item-nao-retornado`. ⚠️ A sonda de 2026-09-16 pegou a
    // Shopee mandando a STRING "FALSE" num campo que a página tipa como boolean
    // (`deboost`), então o cenário não é hipotético.
    const comLinhaRuim = comUmItem({ has_model: 'false' });
    expect(comLinhaRuim.item_list).toEqual([null]);
    expect(() => montarItemLido({ itemId: ITEM_ID, payload: comLinhaRuim })).toThrow(
      /não traz o item/,
    );
    // ⛔ NEAR-MISS do sentinela: a linha BOA do mesmo lote sobrevive à linha ruim.
    const lote = payload({
      item_list: [
        { item_id: ITEM_ID, has_model: true },
        { item_id: OUTRO_ITEM_ID, has_model: 'false' },
      ],
    });
    expect(lote.item_list.map((l) => (l === null ? null : l.item_id))).toEqual([ITEM_ID, null]);
    expect(temModelosDe(montarItemLido({ itemId: ITEM_ID, payload: lote }))).toBe(true);

    // (b) E ainda assim a leitura é `=== true`, exata: um registro montado com a
    // string — um `.passthrough()`, um dobro, um corpus remendado à mão — não
    // tem modelos. `'false'` é truthy em JavaScript, e um `true` errado aqui
    // deixaria um produto pai dono de filhos para os quais não há modelo nenhum.
    const item = montarItemLido({ itemId: ITEM_ID, payload: comUmItem({}) });
    const comString = {
      ...item,
      base: { ...item.base, has_model: 'false' as unknown as boolean },
    };
    expect(temModelosDe(comString)).toBe(false);

    expect(temModelosDe(item)).toBe(false);
    expect(
      temModelosDe(montarItemLido({ itemId: ITEM_ID, payload: comUmItem({ has_model: true }) })),
    ).toBe(true);
  });
});

describe('tiersDe / tiersPadronizadosDe', () => {
  it('11. um get_model_list sem NENHUMA das duas árvores não lança', () => {
    const item = montarItemLido({
      itemId: ITEM_ID,
      payload: comUmItem({ has_model: true }),
      modelos: modelos({ model: [{ model_id: MODEL_ID }] }),
    });
    expect(tiersDe(item)).toEqual([]);
    expect(tiersPadronizadosDe(item)).toEqual([]);
    expect(item.models?.model).toHaveLength(1);
  });

  it('sem get_model_list os dois leitores devolvem [] e models fica null', () => {
    const item = montarItemLido({ itemId: ITEM_ID, payload: comUmItem({}) });
    expect(item.models).toBeNull();
    expect(tiersDe(item)).toEqual([]);
    expect(tiersPadronizadosDe(item)).toEqual([]);
  });

  it('devolve as duas árvores quando elas vêm juntas', () => {
    const item = montarItemLido({
      itemId: ITEM_ID,
      payload: comUmItem({ has_model: true }),
      modelos: modelos({
        tier_variation: [{ name: 'Cor', option_list: [{ option: 'Azul' }] }],
        standardise_tier_variation: [{ variation_id: 0, variation_name: 'Cor' }],
        model: [{ model_id: MODEL_ID }],
      }),
    });
    expect(tiersDe(item)).toHaveLength(1);
    expect(tiersDe(item)[0]?.name).toBe('Cor');
    expect(tiersPadronizadosDe(item)[0]?.variation_id).toBe(0);
  });
});

describe('itemStatusDe', () => {
  it('devolve o status LIDO, solto — um valor novo custa um campo, não um item', () => {
    const item = montarItemLido({
      itemId: ITEM_ID,
      payload: comUmItem({ item_status: 'UM_STATUS_QUE_A_SHOPEE_INVENTAR' }),
    });
    expect(itemStatusDe(item)).toBe('UM_STATUS_QUE_A_SHOPEE_INVENTAR');
    expect(itemStatusDe(montarItemLido({ itemId: ITEM_ID, payload: comUmItem({}) }))).toBeNull();
  });
});

describe('o registro não expõe promotion_id', () => {
  it('12. ⛔ nenhum campo do ItemLido e nenhum acessor o alcança', () => {
    const item = montarItemLido({
      itemId: ITEM_ID,
      payload: comUmItem({ has_model: true }),
      modelos: modelos({ model: [{ model_id: MODEL_ID, promotion_id: 9_007_199_254_740_991 }] }),
    });
    // ⚠️ `promotion_id` virou uint64 em 2026-07-31: acima de 2^53 ele nem
    // sobrevive ao `JSON.parse`, e é estado de promoção volátil. Ele é LIDO pelo
    // schema do modelo e nunca sobe para o registro nem para um acessor.
    expect(Object.keys(item).sort()).toEqual(['base', 'itemId', 'kit', 'models', 'taxInfo']);
    expect(JSON.stringify(item.base)).not.toContain('promotion_id');
    expect(JSON.stringify(tiersDe(item))).not.toContain('promotion_id');
    expect(JSON.stringify(tiersPadronizadosDe(item))).not.toContain('promotion_id');
  });
});

/* -------------------------------------------------------------------------- */
/*  descricaoDe                                                                */
/* -------------------------------------------------------------------------- */

describe('descricaoDe', () => {
  it('13. description_type normal devolve a description', () => {
    const item = montarItemLido({
      itemId: ITEM_ID,
      payload: comUmItem({ description_type: 'normal', description: '  Camiseta lisa  ' }),
    });
    expect(descricaoDe(item)).toBe('Camiseta lisa');
  });

  it('14. extended junta os blocos de TEXTO com uma linha em branco', () => {
    const item = montarItemLido({
      itemId: ITEM_ID,
      payload: comUmItem({
        description_type: 'extended',
        description: '',
        description_info: {
          extended_description: {
            field_list: [
              { field_type: 'text', text: 'Primeiro bloco' },
              { field_type: 'image', image_info: { image_id: 'img-1' } },
              { field_type: 'text', text: 'Segundo bloco' },
            ],
          },
        },
      }),
    });
    expect(descricaoDe(item)).toBe('Primeiro bloco\n\nSegundo bloco');
  });

  it('15. em branco vira null, nunca ""', () => {
    const vazio = montarItemLido({
      itemId: ITEM_ID,
      payload: comUmItem({ description_type: 'normal', description: '   ' }),
    });
    expect(descricaoDe(vazio)).toBeNull();
    expect(descricaoDe(montarItemLido({ itemId: ITEM_ID, payload: comUmItem({}) }))).toBeNull();
  });

  it('16. uma description extended só de IMAGENS é vazia — imagens por bloco são lacuna registrada', () => {
    const item = montarItemLido({
      itemId: ITEM_ID,
      payload: comUmItem({
        description_type: 'extended',
        description: '',
        description_info: {
          extended_description: {
            field_list: [{ field_type: 'image', image_info: { image_id: 'img-1' } }],
          },
        },
      }),
    });
    expect(descricaoDe(item)).toBeNull();
  });

  it('um description_type DESCONHECIDO com blocos extended ainda devolve o texto', () => {
    // As duas fontes são mutuamente exclusivas, então preferir a DECLARADA e
    // cair na outra não mistura nada — e evita importar descrição vazia em
    // silêncio quando a declaração mente.
    const item = montarItemLido({
      itemId: ITEM_ID,
      payload: comUmItem({
        description_type: 'EXTENDED',
        description: '',
        description_info: {
          extended_description: { field_list: [{ field_type: 'text', text: 'Só aqui' }] },
        },
      }),
    });
    expect(descricaoDe(item)).toBe('Só aqui');
  });
});
