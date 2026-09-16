import { describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeNetworkError,
  shopeeItemBaseInfoPayloadSchema,
  shopeeKitItemInfoPayloadSchema,
  shopeeModelListPayloadSchema,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';

import { MOTIVO_IMPORT_BLOQUEADO, ShopeeImportBlockedError } from './errosImportacao';
import { montarItemLido } from './itemLido';
import {
  MSG_ITEM_NAO_ENCONTRADO,
  MSG_ITEM_SEM_LINHA,
  MSG_KIT_SEM_DETALHE,
  lerAnuncioShopee,
} from './lerAnuncio';

const ITEM_ID = 2500139861;
const OUTRO_ITEM_ID = 2500139862;
const MODEL_ID = 2000458802;

function payload(...linhas: Record<string, unknown>[]) {
  return shopeeItemBaseInfoPayloadSchema.parse({ item_list: linhas });
}

const LINHA_SIMPLES = { item_id: ITEM_ID, item_name: 'Camiseta Básica', item_sku: 'CAM-001' };
const LINHA_COM_MODELOS = { ...LINHA_SIMPLES, has_model: true };
const LINHA_KIT = { ...LINHA_SIMPLES, tag: { kit: true } };

const MODELOS = shopeeModelListPayloadSchema.parse({
  model: [{ model_id: MODEL_ID, model_sku: 'CAM-001-A' }],
  tier_variation: [],
});

const KIT = shopeeKitItemInfoPayloadSchema.parse({
  product_info: { item_id: ITEM_ID, item_name: 'Kit de Camisetas' },
});

interface Dobro {
  readonly client: ShopeeClient;
  /** Every call this read made, in ORDER — the property the three patterns are about. */
  readonly chamadas: string[];
}

/**
 * A client whose three product reads are recorded in call order. Anything the
 * read does NOT use is absent from the object, so reaching for it is a
 * `TypeError` rather than a silently mocked success.
 */
function criarCliente(respostas: {
  base?: () => unknown;
  modelos?: () => unknown;
  kit?: () => unknown;
}): Dobro {
  const chamadas: string[] = [];
  const registrar = (nome: string, fn: (() => unknown) | undefined) => (): Promise<unknown> => {
    chamadas.push(nome);
    if (fn === undefined) throw new Error(`lerAnuncioShopee chamou ${nome} e não devia`);
    return Promise.resolve(fn());
  };

  const client = {
    getItemBaseInfo: vi.fn(registrar('getItemBaseInfo', respostas.base)),
    getModelList: vi.fn(registrar('getModelList', respostas.modelos)),
    getKitItemInfo: vi.fn(registrar('getKitItemInfo', respostas.kit)),
  } as unknown as ShopeeClient;

  return { client, chamadas };
}

describe('os três padrões de chamada', () => {
  it('um anúncio simples custa UMA chamada e mais nenhuma', async () => {
    const dobro = criarCliente({ base: () => payload(LINHA_SIMPLES) });

    const lido = await lerAnuncioShopee(dobro.client, ITEM_ID);

    expect(dobro.chamadas).toEqual(['getItemBaseInfo']);
    expect(lido.models).toBeNull();
    expect(lido.kit).toBeNull();
  });

  it('has_model true lê os modelos, nesta ordem', async () => {
    const dobro = criarCliente({
      base: () => payload(LINHA_COM_MODELOS),
      modelos: () => MODELOS,
    });

    const lido = await lerAnuncioShopee(dobro.client, ITEM_ID);

    expect(dobro.chamadas).toEqual(['getItemBaseInfo', 'getModelList']);
    expect(lido.models?.model[0]?.model_id).toBe(MODEL_ID);
  });

  it('⛔ has_model ausente NÃO lê modelos — a leitura exige o true exato', async () => {
    // Shopee preenche com zero e o campo é deliberadamente não-estrito no
    // schema; ler por veracidade daria a um anúncio simples uma lista de
    // modelos vazia e um pai com filhos que não existem.
    const dobro = criarCliente({ base: () => payload({ ...LINHA_SIMPLES, has_model: false }) });

    await lerAnuncioShopee(dobro.client, ITEM_ID);

    expect(dobro.chamadas).toEqual(['getItemBaseInfo']);
  });

  it('um kit lê get_kit_item_info e NUNCA get_model_list', async () => {
    const dobro = criarCliente({ base: () => payload(LINHA_KIT), kit: () => KIT });

    const lido = await lerAnuncioShopee(dobro.client, ITEM_ID);

    expect(dobro.chamadas).toEqual(['getItemBaseInfo', 'getKitItemInfo']);
    expect(lido.kit?.item_id).toBe(ITEM_ID);
    expect(lido.models).toBeNull();
  });

  it('⛔ um kit que TAMBÉM diz has_model continua sem pedir modelos', async () => {
    // O que `get_model_list` responde para um kit não está verificado; gastar a
    // chamada e planejar variações com o que voltasse seria inventar dados.
    const dobro = criarCliente({
      base: () => payload({ ...LINHA_KIT, has_model: true }),
      kit: () => KIT,
    });

    await lerAnuncioShopee(dobro.client, ITEM_ID);

    expect(dobro.chamadas).toEqual(['getItemBaseInfo', 'getKitItemInfo']);
  });
});

describe('o registro montado é o MESMO que o job monta', () => {
  it('bate campo a campo com montarItemLido', async () => {
    const corpo = payload(LINHA_COM_MODELOS);
    const dobro = criarCliente({ base: () => corpo, modelos: () => MODELOS });

    const lido = await lerAnuncioShopee(dobro.client, ITEM_ID);

    expect(lido).toEqual(
      montarItemLido({ itemId: ITEM_ID, payload: corpo, linha: null, modelos: MODELOS }),
    );
  });
});

describe('as duas recusas que esta leitura decide sozinha', () => {
  it('uma resposta sem a linha do item vira item-nao-encontrado', async () => {
    const dobro = criarCliente({
      base: () => payload({ ...LINHA_SIMPLES, item_id: OUTRO_ITEM_ID }),
    });

    await expect(lerAnuncioShopee(dobro.client, ITEM_ID)).rejects.toMatchObject({
      motivo: MOTIVO_IMPORT_BLOQUEADO.itemNaoEncontrado,
      itemId: ITEM_ID,
      mensagem: MSG_ITEM_SEM_LINHA,
    });
  });

  it('uma resposta VAZIA também vira item-nao-encontrado', async () => {
    const dobro = criarCliente({ base: () => payload() });

    await expect(lerAnuncioShopee(dobro.client, ITEM_ID)).rejects.toBeInstanceOf(
      ShopeeImportBlockedError,
    );
  });

  it('error_item_not_found no envelope vira o mesmo motivo, com a sua frase', async () => {
    const dobro = criarCliente({
      base: () => {
        throw new ShopeeApiError('item desconhecido', {
          code: 'error_item_not_found',
          kind: SHOPEE_ERROR_KIND.other,
          httpStatus: 200,
          path: '/api/v2/product/get_item_base_info',
        });
      },
    });

    await expect(lerAnuncioShopee(dobro.client, ITEM_ID)).rejects.toMatchObject({
      motivo: MOTIVO_IMPORT_BLOQUEADO.itemNaoEncontrado,
      mensagem: MSG_ITEM_NAO_ENCONTRADO,
    });
  });

  it('um kit sem product_info vira kit-sem-detalhe', async () => {
    const dobro = criarCliente({
      base: () => payload(LINHA_KIT),
      kit: () => shopeeKitItemInfoPayloadSchema.parse({ product_info: null }),
    });

    await expect(lerAnuncioShopee(dobro.client, ITEM_ID)).rejects.toMatchObject({
      motivo: MOTIVO_IMPORT_BLOQUEADO.kitSemDetalhe,
      mensagem: MSG_KIT_SEM_DETALHE,
    });
  });
});

describe('o que NÃO é propriedade deste anúncio sobe intacto', () => {
  it('⛔ uma falha de rede NÃO vira item-nao-encontrado', async () => {
    // Contê-la aqui cadastraria a indisponibilidade da Shopee como "este
    // anúncio não existe", e o operador procuraria um anúncio que está lá.
    const dobro = criarCliente({
      base: () => {
        throw new ShopeeNetworkError('fetch falhou');
      },
    });

    await expect(lerAnuncioShopee(dobro.client, ITEM_ID)).rejects.toBeInstanceOf(
      ShopeeNetworkError,
    );
  });

  it('⛔ um error_param NÃO é confundido com item-nao-encontrado', async () => {
    const dobro = criarCliente({
      base: () => {
        throw new ShopeeApiError('parâmetro inválido', {
          code: 'error_param',
          kind: SHOPEE_ERROR_KIND.other,
          httpStatus: 200,
          path: '/api/v2/product/get_item_base_info',
        });
      },
    });

    await expect(lerAnuncioShopee(dobro.client, ITEM_ID)).rejects.not.toBeInstanceOf(
      ShopeeImportBlockedError,
    );
  });
});
