import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  SHOPEE_ERROR_KIND,
  ShopeeConfigError,
  ShopeeRateLimitError,
  shopeeItemBaseInfoPayloadSchema,
  shopeeItemBaseInfoRowSchema,
  shopeeModelListPayloadSchema,
  type GetItemBaseInfoParams,
  type ShopeeClient,
  type ShopeeItemBaseInfoRow,
  type ShopeeModelList,
} from '@delfrance/integrations-shopee';

import { SHOPEE_PRECO_MODEL_ID_SEM_MODELO } from './constantesPreco';
import { criarLeitorDeBaseEmLote, type LeitorDeBase } from './leitorDeBase';
import { lerItemParaPreco, projetarLeitura } from './leituraPreco';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

const ITEM = 2_500_139_861;
const MODELO_A = 2_000_458_802;
const MODELO_B = 2_000_458_803;

/** This module's raw TEXT — the comparand discipline is measured on it. */
const FONTE = readFileSync(fileURLToPath(new URL('./leituraPreco.ts', import.meta.url)), 'utf8');

/** A base row as the client would hand it over (every default applied). */
function base(over: Record<string, unknown> = {}): ShopeeItemBaseInfoRow {
  return shopeeItemBaseInfoRowSchema.parse({
    item_id: ITEM,
    item_status: 'NORMAL',
    has_model: false,
    price_info: [{ currency: 'SGD', original_price: 10, current_price: 10 }],
    ...over,
  });
}

/** One price entry, raw. */
function preco(original: unknown, current: unknown, currency: unknown = 'SGD') {
  return { currency, original_price: original, current_price: current };
}

/** `get_model_list`'s payload with the given raw models. */
function lista(modelos: readonly Record<string, unknown>[]): ShopeeModelList {
  return shopeeModelListPayloadSchema.parse({ model: modelos });
}

/** The no-model listing's single projected entry. */
function unica(over: Record<string, unknown>) {
  const leitura = projetarLeitura(base(over), null);
  expect(leitura.modelos).toHaveLength(1);
  const [entrada] = leitura.modelos;
  return entrada;
}

/** A client double: `getModelList` answers `modelos`; `getItemBaseInfo` echoes `linhas`. */
function cliente(
  opts: { modelos?: ShopeeModelList; linhas?: readonly Record<string, unknown>[] } = {},
) {
  const getModelList = vi.fn(async () => opts.modelos ?? lista([]));
  const getItemBaseInfo = vi.fn(async (_p: GetItemBaseInfoParams) =>
    shopeeItemBaseInfoPayloadSchema.parse({ item_list: opts.linhas ?? [] }),
  );
  return {
    client: { getModelList, getItemBaseInfo } as unknown as ShopeeClient,
    getModelList,
    getItemBaseInfo,
  };
}

/** A `LeitorDeBase` that answers `linha` for every id. */
function leitorFixo(linha: ShopeeItemBaseInfoRow | null): LeitorDeBase {
  return async () => linha;
}

/* -------------------------------------------------------------------------- */
/*                                projetarLeitura                              */
/* -------------------------------------------------------------------------- */

describe('projetarLeitura — o anúncio SEM modelos', () => {
  it('1 — PAR: UMA entrada, modelId = SHOPEE_PRECO_MODEL_ID_SEM_MODELO (0), status null, preço e moeda da linha base', () => {
    expect(SHOPEE_PRECO_MODEL_ID_SEM_MODELO).toBe(0);
    expect(projetarLeitura(base(), null)).toEqual({
      itemStatus: 'NORMAL',
      temModelos: false,
      modelos: [{ modelId: 0, precoAnterior: 10, moeda: 'SGD', status: null }],
    });
  });

  it('2 — ⚠️ QUASE-IGUAL (M47): original 10 e current 8 (uma promoção) ⇒ 10 — nunca o preço promocional', () => {
    expect(unica({ price_info: [preco(10, 8)] })?.precoAnterior).toBe(10);
  });

  it('3 — ⚠️ PAR (C-f): original ZERADO ou AUSENTE e current 9 ⇒ 9 (o fallback de prateleira do passo 9)', () => {
    expect(unica({ price_info: [preco(0, 9)] })?.precoAnterior).toBe(9);
    expect(unica({ price_info: [preco(null, 9)] })?.precoAnterior).toBe(9);
  });

  it.each([
    [0, 0],
    [-1, 0],
    [null, null],
    [0, -5],
  ])(
    '4 — QUASE-IGUAL (C-f): os dois não-positivos (original %s, current %s) ⇒ null — nunca um preço zero',
    (original, current) => {
      expect(unica({ price_info: [preco(original, current)] })?.precoAnterior).toBeNull();
    },
  );

  it('5 — ⚠️ positividade DEPOIS do arredondamento: 0.004 ⇒ null, e o quase-igual 0.005 ⇒ 0.01', () => {
    expect(unica({ price_info: [preco(0.004, 0)] })?.precoAnterior).toBeNull();
    expect(unica({ price_info: [preco(0.005, 0)] })?.precoAnterior).toBe(0.01);
  });

  it('6 — arredondado ao centavo com roundReais: 10.567 ⇒ 10.57, 49.991 ⇒ 49.99', () => {
    expect(unica({ price_info: [preco(10.567, 10.567)] })?.precoAnterior).toBe(10.57);
    expect(unica({ price_info: [preco(49.991, 49.991)] })?.precoAnterior).toBe(49.99);
  });

  it('7 — moeda VERBATIM: SGD fica SGD, "brl" NÃO vira BRL, ausente ⇒ null', () => {
    expect(unica({ price_info: [preco(10, 10, 'SGD')] })?.moeda).toBe('SGD');
    expect(unica({ price_info: [preco(10, 10, 'brl')] })?.moeda).toBe('brl');
    expect(unica({ price_info: [preco(10, 10, null)] })?.moeda).toBeNull();
  });

  it('8 — lê SÓ a PRIMEIRA entrada de price_info: [SGD 10, BRL 20] ⇒ 10 SGD — nunca "escolhe" a BRL', () => {
    expect(unica({ price_info: [preco(10, 10, 'SGD'), preco(20, 20, 'BRL')] })).toEqual({
      modelId: 0,
      precoAnterior: 10,
      moeda: 'SGD',
      status: null,
    });
  });

  it.each([[null], [[]]])(
    '9 — price_info %j ⇒ ainda UMA entrada, com preço e moeda null',
    (priceInfo) => {
      expect(unica({ price_info: priceInfo })).toEqual({
        modelId: 0,
        precoAnterior: null,
        moeda: null,
        status: null,
      });
    },
  );

  it.each(['NORMAL', 'BANNED', 'SELLER_DELETE', 'FOO', null])(
    '10 — itemStatus VERBATIM (%s) — um status que a Shopee invente chega como ele mesmo',
    (status) => {
      expect(projetarLeitura(base({ item_status: status }), null).itemStatus).toBe(status);
    },
  );

  it('11 — sem modelos, uma lista passada mesmo assim é IGNORADA (P3: a Shopee responderia zero modelos)', () => {
    const leitura = projetarLeitura(
      base({ has_model: false }),
      lista([{ model_id: MODELO_A, price_info: [preco(99, 99)] }]),
    );
    expect(leitura.modelos).toEqual([
      { modelId: 0, precoAnterior: 10, moeda: 'SGD', status: null },
    ]);
  });
});

describe('projetarLeitura — o anúncio COM modelos', () => {
  it('12 — ⚠️ temModelos EXATO: só o literal true; false e null são "sem modelos"', () => {
    expect(projetarLeitura(base({ has_model: true }), lista([])).temModelos).toBe(true);
    expect(projetarLeitura(base({ has_model: false }), null).temModelos).toBe(false);
    expect(projetarLeitura(base({ has_model: null }), null).temModelos).toBe(false);
  });

  it('13 — uma entrada POR MODELO, na ordem do get_model_list, com id, status e preço de CADA modelo; o price_info da base é ignorado', () => {
    const leitura = projetarLeitura(
      base({ has_model: true, price_info: [preco(77, 77, 'BRL')] }),
      lista([
        {
          model_id: MODELO_B,
          model_status: 'MODEL_UNAVAILABLE',
          price_info: [preco(20, 15, 'SGD')],
        },
        { model_id: MODELO_A, model_status: 'MODEL_NORMAL', price_info: [preco(0, 12.346, 'SGD')] },
      ]),
    );
    expect(leitura).toEqual({
      itemStatus: 'NORMAL',
      temModelos: true,
      modelos: [
        { modelId: MODELO_B, precoAnterior: 20, moeda: 'SGD', status: 'MODEL_UNAVAILABLE' },
        { modelId: MODELO_A, precoAnterior: 12.35, moeda: 'SGD', status: 'MODEL_NORMAL' },
      ],
    });
  });

  it('14 — um modelo sem price_info ⇒ preço e moeda null, o modelo continua na leitura', () => {
    const leitura = projetarLeitura(
      base({ has_model: true }),
      lista([{ model_id: MODELO_A, model_status: 'MODEL_NORMAL' }]),
    );
    expect(leitura.modelos).toEqual([
      { modelId: MODELO_A, precoAnterior: null, moeda: null, status: 'MODEL_NORMAL' },
    ]);
  });

  it('15 — QUASE-IGUAL: com modelos mas SEM lista (null) ⇒ nenhuma entrada — nunca o preço da base', () => {
    const leitura = projetarLeitura(base({ has_model: true }), null);
    expect(leitura.temModelos).toBe(true);
    expect(leitura.modelos).toEqual([]);
  });
});

describe('projetarLeitura — o que NÃO é lido', () => {
  it('16 — PAR (B-6): o sinal de promoção do item não muda nada — true, false e null dão a MESMA projeção', () => {
    const referencia = projetarLeitura(base({ has_promotion: false }), null);
    expect(projetarLeitura(base({ has_promotion: true }), null)).toEqual(referencia);
    expect(projetarLeitura(base({ has_promotion: null }), null)).toEqual(referencia);
  });

  it('17 — ⛔ (M47) o módulo não soletra nenhum campo de preço do wire nem o sinal de promoção: lê pelo precoDePrateleiraDe', () => {
    // Runtime-built needles, so this file does not trip the folder greps either.
    for (const proibido of [
      ['current', 'price'],
      ['original', 'price'],
      ['has', 'promotion'],
    ]) {
      expect(FONTE).not.toContain(proibido.join('_'));
    }
    expect(FONTE).toMatch(/import \{ precoDePrateleiraDe \} from '\.\.\/produtos\/mapeamento';/);
    expect(FONTE).toMatch(/import \{ roundReais \} from '@delfrance\/core\/money';/);
  });
});

/* -------------------------------------------------------------------------- */
/*                                lerItemParaPreco                             */
/* -------------------------------------------------------------------------- */

describe('lerItemParaPreco', () => {
  it('18 — ausente no lote ⇒ { ausente: true }, e get_model_list NÃO é chamado', async () => {
    const c = cliente();
    expect(await lerItemParaPreco(c.client, ITEM, leitorFixo(null))).toEqual({ ausente: true });
    expect(c.getModelList).not.toHaveBeenCalled();
  });

  it.each([false, null])(
    '19 — ⚠️ PAR (M48): has_model %s ⇒ ZERO get_model_list, chamadas 0, a única entrada vem da base',
    async (hasModel) => {
      const c = cliente();
      const r = await lerItemParaPreco(c.client, ITEM, leitorFixo(base({ has_model: hasModel })));
      expect(r).toEqual({
        ausente: false,
        chamadas: 0,
        leitura: {
          itemStatus: 'NORMAL',
          temModelos: false,
          modelos: [{ modelId: 0, precoAnterior: 10, moeda: 'SGD', status: null }],
        },
      });
      expect(c.getModelList).not.toHaveBeenCalled();
    },
  );

  it('20 — ⚠️ QUASE-IGUAL (M48): has_model true ⇒ UMA get_model_list com o item_id, chamadas 1, modelos projetados', async () => {
    const c = cliente({
      modelos: lista([
        { model_id: MODELO_A, model_status: 'MODEL_NORMAL', price_info: [preco(12, 12)] },
      ]),
    });
    const r = await lerItemParaPreco(c.client, ITEM, leitorFixo(base({ has_model: true })));
    expect(c.getModelList).toHaveBeenCalledTimes(1);
    expect(c.getModelList).toHaveBeenCalledWith({ itemId: ITEM });
    expect(r).toEqual({
      ausente: false,
      chamadas: 1,
      leitura: {
        itemStatus: 'NORMAL',
        temModelos: true,
        modelos: [{ modelId: MODELO_A, precoAnterior: 12, moeda: 'SGD', status: 'MODEL_NORMAL' }],
      },
    });
  });

  it('21 — um leitor que devolve a linha de OUTRO item ⇒ ShopeeConfigError, e nenhuma get_model_list', async () => {
    const c = cliente();
    const outro = base({ item_id: ITEM + 1, has_model: true });
    await expect(lerItemParaPreco(c.client, ITEM, leitorFixo(outro))).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(c.getModelList).not.toHaveBeenCalled();
  });

  it('22 — o erro de get_model_list chega VERBATIM (a MESMA instância) — nada é capturado aqui', async () => {
    const erro = new ShopeeRateLimitError('limite de rajada', {
      code: 'error_rate_limit',
      kind: SHOPEE_ERROR_KIND.burst,
      httpStatus: 429,
      path: '/api/v2/product/get_model_list',
      retryAfterSeconds: null,
    });
    const c = cliente();
    c.getModelList.mockRejectedValueOnce(erro);
    await expect(
      lerItemParaPreco(c.client, ITEM, leitorFixo(base({ has_model: true }))),
    ).rejects.toBe(erro);
  });

  it('23 — o erro do leitor de base chega VERBATIM, e get_model_list não é chamado', async () => {
    const erro = new Error('falha do lote');
    const c = cliente();
    const lerBase: LeitorDeBase = async () => {
      throw erro;
    };
    await expect(lerItemParaPreco(c.client, ITEM, lerBase)).rejects.toBe(erro);
    expect(c.getModelList).not.toHaveBeenCalled();
  });

  it('24 — com o leitor em LOTE real: três itens (um com modelos, um ausente) ⇒ UMA get_item_base_info + UMA get_model_list', async () => {
    const c = cliente({
      linhas: [
        { item_id: ITEM, item_status: 'NORMAL', has_model: false, price_info: [preco(10, 10)] },
        { item_id: ITEM + 1, item_status: 'NORMAL', has_model: true },
      ],
      modelos: lista([
        { model_id: MODELO_A, model_status: 'MODEL_NORMAL', price_info: [preco(5, 5)] },
      ]),
    });
    const lerBase = criarLeitorDeBaseEmLote(c.client, [ITEM, ITEM + 1, ITEM + 2]);
    const [semModelos, comModelos, ausente] = await Promise.all([
      lerItemParaPreco(c.client, ITEM, lerBase),
      lerItemParaPreco(c.client, ITEM + 1, lerBase),
      lerItemParaPreco(c.client, ITEM + 2, lerBase),
    ]);
    expect(semModelos).toMatchObject({ ausente: false, chamadas: 0 });
    expect(comModelos).toMatchObject({ ausente: false, chamadas: 1 });
    expect(ausente).toEqual({ ausente: true });
    expect(c.getItemBaseInfo).toHaveBeenCalledTimes(1);
    expect(c.getModelList).toHaveBeenCalledTimes(1);
    expect(c.getModelList).toHaveBeenCalledWith({ itemId: ITEM + 1 });
  });
});
