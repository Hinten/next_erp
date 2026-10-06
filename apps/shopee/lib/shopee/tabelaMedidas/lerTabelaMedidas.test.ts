import { describe, expect, it, vi } from 'vitest';
import {
  SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
  SHOPEE_SURFACE,
  ShopeeSchemaError,
  assertSizeChartDetailParams,
  lerPaginaDeTabelasDeMedidas,
  shopeeErrorFromEnvelope,
  type GetSizeChartDetailParams,
  type ShopeeClient,
  type ShopeeSizeChartDetail,
} from '@delfrance/integrations-shopee';
import {
  PROBLEMA_TABELA_SHOPEE,
  TIPO_CELULA_TABELA_SHOPEE,
  projetarTabelaShopee,
  tabelaShopeeProjetadaSchema,
} from '@delfrance/schemas';

import {
  FIXTURE_SIZE_CHART_DETAIL_DOC,
  FIXTURE_SIZE_CHART_LIST_DOC,
  lerDetalheDeTabelaDeMedidas,
  lerListaDeTabelasDeMedidas,
} from '../fixtures/wireCorpus';
import { lerTabelaDeMedidasShopee } from './lerTabelaMedidas';

/**
 * ⚠️ Shopee's two doc samples print DIFFERENT charts: the detail sample echoes
 * `700024639`, which is none of the list sample's ids. So the detail sample is
 * clean only when 700024639 itself is asked for; any list id yields exactly one
 * `id-divergente`.
 */
const ID_DO_EXEMPLO = 700024639;

/** A client whose detail read resolves `detalhe` — what the real op resolves with (`res.response`). */
function clienteCom(detalhe: () => Promise<ShopeeSizeChartDetail>) {
  const getSizeChartDetail = vi.fn((_: GetSizeChartDetailParams) => detalhe());
  const client = { getSizeChartDetail } as unknown as ShopeeClient;
  return { client, getSizeChartDetail };
}

function doExemplo(): Promise<ShopeeSizeChartDetail> {
  return Promise.resolve(lerDetalheDeTabelaDeMedidas(FIXTURE_SIZE_CHART_DETAIL_DOC));
}

describe('lerTabelaDeMedidasShopee — o exemplo da página', () => {
  it('pedido o id do exemplo: 3 colunas × 3 linhas, sem problemas, e o corpo passa no schema de saída', async () => {
    const { client } = clienteCom(doExemplo);

    const tabela = await lerTabelaDeMedidasShopee({ client }, ID_DO_EXEMPLO);

    expect(tabelaShopeeProjetadaSchema.parse(JSON.parse(JSON.stringify(tabela)))).toEqual(tabela);
    expect(tabela.sizeChartId).toBe(ID_DO_EXEMPLO);
    expect(tabela.sizeChartName).toBe('testtestt');
    expect(tabela.problemas).toEqual([]);
    expect(tabela.colunas.map((c) => c.inputType)).toEqual([
      'Input Single Number',
      'Input Range Number',
      'Single Dropdown',
    ]);
    expect(tabela.linhas).not.toBeNull();
    expect(tabela.linhas).toHaveLength(3);
    for (const linha of tabela.linhas ?? []) expect(linha).toHaveLength(3);
    expect(tabela.linhas?.[0]?.map((c) => c.tipo)).toEqual([
      TIPO_CELULA_TABELA_SHOPEE.numero,
      TIPO_CELULA_TABELA_SHOPEE.faixa,
      TIPO_CELULA_TABELA_SHOPEE.opcao,
    ]);
  });

  it('é a projeção do projetor, intacta — nada é re-projetado aqui', async () => {
    const { client } = clienteCom(doExemplo);
    const esperado = projetarTabelaShopee(
      ID_DO_EXEMPLO,
      lerDetalheDeTabelaDeMedidas(FIXTURE_SIZE_CHART_DETAIL_DOC),
    );
    await expect(lerTabelaDeMedidasShopee({ client }, ID_DO_EXEMPLO)).resolves.toEqual(esperado);
  });

  it('pede exatamente UM detalhe, com exatamente a chave `sizeChartId`', async () => {
    const { client, getSizeChartDetail } = clienteCom(doExemplo);
    await lerTabelaDeMedidasShopee({ client }, ID_DO_EXEMPLO);
    expect(getSizeChartDetail).toHaveBeenCalledTimes(1);
    expect(getSizeChartDetail.mock.calls[0]?.[0]).toStrictEqual({ sizeChartId: ID_DO_EXEMPLO });
  });

  it('o sizeChartId da resposta é o PEDIDO, nunca o eco — ±1 vira UM id-divergente', async () => {
    for (const pedido of [ID_DO_EXEMPLO + 1, ID_DO_EXEMPLO - 1]) {
      const { client } = clienteCom(doExemplo);
      const tabela = await lerTabelaDeMedidasShopee({ client }, pedido);
      expect(tabela.sizeChartId).toBe(pedido);
      expect(tabela.problemas).toEqual([
        {
          codigo: PROBLEMA_TABELA_SHOPEE.idDivergente,
          coluna: null,
          linha: null,
          inputType: null,
          comprimentos: null,
          pedido,
          recebido: ID_DO_EXEMPLO,
        },
      ]);
    }
  });
});

describe('RT2 — lista do exemplo → leitor da página → guarda do detalhe → detalhe do exemplo → projeção', () => {
  it('cada id LISTADO passa na guarda e projeta 3×3 com exatamente UM problema: o eco divergente', async () => {
    const pagina = lerPaginaDeTabelasDeMedidas(
      lerListaDeTabelasDeMedidas(FIXTURE_SIZE_CHART_LIST_DOC),
    );
    expect(pagina.ids).toHaveLength(3);
    expect(pagina.ids).not.toContain(ID_DO_EXEMPLO);

    for (const id of pagina.ids) {
      expect(() => assertSizeChartDetailParams({ sizeChartId: id })).not.toThrow();
      const { client, getSizeChartDetail } = clienteCom(doExemplo);

      const tabela = tabelaShopeeProjetadaSchema.parse(
        JSON.parse(JSON.stringify(await lerTabelaDeMedidasShopee({ client }, id))),
      );

      expect(getSizeChartDetail.mock.calls[0]?.[0]).toStrictEqual({ sizeChartId: id });
      expect(tabela.sizeChartId).toBe(id);
      expect(tabela.colunas).toHaveLength(3);
      expect(tabela.linhas).toHaveLength(3);
      for (const linha of tabela.linhas ?? []) expect(linha).toHaveLength(3);
      expect(tabela.problemas).toEqual([
        {
          codigo: PROBLEMA_TABELA_SHOPEE.idDivergente,
          coluna: null,
          linha: null,
          inputType: null,
          comprimentos: null,
          pedido: id,
          recebido: ID_DO_EXEMPLO,
        },
      ]);
    }
  });
});

describe('lerTabelaDeMedidasShopee — falhas chegam INTACTAS à rota (nenhum catch aqui)', () => {
  it('a recusa de id inexistente é a MESMA instância que o cliente lançou', async () => {
    const recusa = shopeeErrorFromEnvelope(
      {
        error: 'product.error_param',
        message: 'Size chart id not exist in this shop',
        request_id: null,
        warning: null,
      },
      {
        path: SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
        httpStatus: 200,
        surface: SHOPEE_SURFACE.business,
      },
    );
    const { client } = clienteCom(() => Promise.reject(recusa));
    await expect(lerTabelaDeMedidasShopee({ client }, ID_DO_EXEMPLO)).rejects.toBe(recusa);
  });

  it('uma falha de schema e um erro estranho também', async () => {
    const schema = new ShopeeSchemaError('corpo ilegível', {
      campos: ['response.size_chart_table'],
      httpStatus: 200,
      path: SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
    });
    const deSchema = clienteCom(() => Promise.reject(schema));
    await expect(lerTabelaDeMedidasShopee({ client: deSchema.client }, 1)).rejects.toBe(schema);

    const estranho = new TypeError('bug');
    const deBug = clienteCom(() => Promise.reject(estranho));
    await expect(lerTabelaDeMedidasShopee({ client: deBug.client }, 1)).rejects.toBe(estranho);
  });
});
