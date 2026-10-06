import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SHOPEE_ADD_ITEM_PATH,
  SHOPEE_SURFACE,
  SHOPEE_UPDATE_ITEM_PATH,
  ShopeeApiError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  createShopeeClient,
  resolveShopeeHosts,
  shopeeErrorFromEnvelope,
} from '@delfrance/integrations-shopee';

import { FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE, lerFixture } from '../fixtures/wireCorpus';
import {
  FRASE_TABELA_MEDIDAS_INEXISTENTE,
  MOTIVO_RECUSA_TABELA_MEDIDAS,
  classificarRecusaTabelaMedidas,
} from '../tabelaMedidas/recusaTabelaMedidas';
import { FRASE_TAX_INFO_INCOMPLETO } from './constantesAnuncio';
import { MOTIVO_PROBLEMA_PUBLICACAO, type MotivoProblemaPublicacao } from './errosPublicacao';
import {
  FRASE_TABELA_MEDIDAS_FOTO_RECUSADA,
  MENSAGEM_TABELA_MEDIDAS_FOTO_NAO_ENVIADA,
  MENSAGEM_TABELA_MEDIDAS_FOTO_RECUSADA,
  MENSAGEM_TABELA_MEDIDAS_RECUSADA,
  problemaDeErroShopee,
  problemasDeErroShopee,
} from './problemasPublicacao';

/* ---------------------------------- fixtures ------------------------------ */

const CAMINHO = '/api/v2/product/add_item';

function apiError(code: string, message: string, kind = 'other' as const): ShopeeApiError {
  return new ShopeeApiError(message, { code, kind, httpStatus: 200, path: CAMINHO });
}

/* -------------------------------------------------------------------------- */
/*                   (1) a tabela — uma fixture por família                    */
/* -------------------------------------------------------------------------- */

interface Linha {
  readonly rotulo: string;
  readonly code: string;
  readonly message: string;
  readonly campo: string | null;
  readonly motivo: MotivoProblemaPublicacao;
  /** The expected `mensagem` when the row carries OUR sentence; absent ⇒ Shopee's prose. */
  readonly mensagem?: string;
}

const TABELA: readonly Linha[] = [
  {
    rotulo: 'categoria — código enumerado',
    code: 'product.error_invalid_category',
    message: 'category is invalid',
    campo: 'category_id',
    motivo: 'categoria-invalida',
  },
  {
    rotulo: 'categoria — prefixo de família (um código irmão não publicado)',
    code: 'error_category_something_new',
    message: 'category refused',
    campo: 'category_id',
    motivo: 'categoria-invalida',
  },
  {
    rotulo: 'atributos',
    code: 'error_less_required_attribute',
    message: 'some required attributes are missing',
    campo: 'attribute_list',
    motivo: 'atributo-obrigatorio',
  },
  {
    rotulo: 'marca',
    code: 'product.error_invalid_brand',
    message: 'brand is invalid',
    campo: 'brand',
    motivo: 'marca-sem-nome',
  },
  {
    rotulo: 'logística — código',
    code: 'error_invalid_logistic_info',
    message: 'logistic info is invalid',
    campo: 'logistic_info',
    motivo: 'logistica-sem-canal',
  },
  {
    rotulo: 'logística — frase de um error_param genérico',
    code: 'product.error_param',
    message: 'Invalid logistic info',
    campo: 'logistic_info',
    motivo: 'logistica-sem-canal',
  },
  {
    rotulo: 'imagens',
    code: 'error_image_num_min',
    message: 'at least one image is required',
    campo: 'image',
    motivo: 'sem-fotos',
  },
  {
    // ⚠️ The TEMPLATE row is not here: it is decided over the ERROR (the routes'
    // classifier), and this table drives the code+sentence form — see (1b).
    rotulo: 'tabela de medidas — o validador de IMAGEM recusou a foto (passo 18)',
    code: 'product.error_busi',
    message: 'Upload failed, please upload a more standard size chart image.',
    campo: 'size_chart_info',
    motivo: 'tabela-de-medidas-foto-recusada',
    mensagem: MENSAGEM_TABELA_MEDIDAS_FOTO_RECUSADA,
  },
  {
    rotulo: 'preço',
    code: 'error_price_exceed_max_limitt',
    message: 'price exceeds the max limit',
    campo: 'original_price',
    motivo: 'preco-fora-da-faixa',
  },
  {
    rotulo: 'estoque abaixo do mínimo da loja (medido no sandbox)',
    code: 'product.error_busi',
    message: 'Stock should be within 2-1000000 for model',
    campo: 'seller_stock',
    motivo: 'estoque-abaixo-do-minimo',
  },
  {
    rotulo: 'estoque reservado — nenhum campo do ERP produz',
    code: 'product.error_auth',
    message: 'Total stock must be more than reserved stock.',
    campo: 'seller_stock',
    motivo: 'desconhecido',
  },
  {
    rotulo: 'nome',
    code: 'error_title_exceeds_max_length',
    message: 'title is too long',
    campo: 'item_name',
    motivo: 'nome-fora-da-faixa',
  },
  {
    rotulo: 'descrição',
    code: 'error_desc_length_min_limit',
    message: 'description is too short',
    campo: 'description',
    motivo: 'descricao-fora-da-faixa',
  },
  {
    rotulo: 'imposto — o bloco que enviamos não foi aceito',
    code: 'product.error_param',
    message: 'invalid additional information',
    campo: 'tax_info',
    motivo: 'imposto-recusado',
  },
  {
    rotulo: 'imposto — a frase do bloco BR incompleto, se voltar depois do reenvio',
    code: 'product.error_param',
    message: FRASE_TAX_INFO_INCOMPLETO,
    campo: 'tax_info',
    motivo: 'imposto-recusado',
  },
  {
    rotulo: 'dimensões',
    code: 'product.error_param',
    message: 'dimension is required',
    campo: 'dimension',
    motivo: 'sem-dimensoes',
  },
  {
    rotulo: 'peso',
    code: 'product.error_param',
    message: 'Invalid Weight.',
    campo: 'weight',
    motivo: 'sem-peso',
  },
  {
    rotulo: 'gtin',
    code: 'product.error_busi',
    message: 'The GTIN code is mandatory for this leaf',
    campo: 'gtin_code',
    motivo: 'sem-gtin',
  },
  {
    rotulo: 'pre-order — nenhum campo do ERP produz',
    code: 'error_invalid_days_to_ship',
    message: 'days to ship is invalid',
    campo: 'pre_order',
    motivo: 'desconhecido',
  },
  {
    rotulo: 'modelos',
    code: 'error_tier_index',
    message: 'tier index is wrong',
    campo: 'model_list',
    motivo: 'variacao-sem-vinculo',
  },
  {
    rotulo: 'modelos — prefixo error_tier_var_is_',
    code: 'error_tier_var_is_something',
    message: 'tier variation refused',
    campo: 'model_list',
    motivo: 'variacao-sem-vinculo',
  },
  {
    rotulo: 'opções demais',
    code: 'error_tier_opt_too_many',
    message: 'too many options',
    campo: 'standardise_tier_variation',
    motivo: 'opcoes-demais',
  },
  {
    rotulo: 'bloqueio por promoção',
    code: 'error_cannt_edit_name_in_promotion',
    message: 'can not edit name while the item is in a promotion',
    campo: 'item_name',
    motivo: 'bloqueado-por-promocao',
  },
  {
    rotulo: 'loja — nada sobre este produto',
    code: 'error_reach_shop_item_limit',
    message: 'shop item limit reached',
    campo: 'shop',
    motivo: 'desconhecido',
  },
  {
    rotulo: 'listagem removida',
    code: 'product.error_item_not_found',
    message: 'item not found',
    campo: 'item_id',
    motivo: 'listagem-removida',
  },
  {
    rotulo: 'nenhuma família — a prosa da Shopee é tudo que o operador recebe',
    code: 'product.error_param',
    message: 'something we have never seen',
    campo: null,
    motivo: 'desconhecido',
  },
];

describe('problemaDeErroShopee — a tabela de famílias', () => {
  it.each(TABELA)('$rotulo', (linha) => {
    expect(problemaDeErroShopee(linha.code, linha.message)).toEqual({
      campo: linha.campo,
      motivo: linha.motivo,
      mensagem: linha.mensagem ?? linha.message,
    });
  });

  it('a tabela exercita os dezenove campos do desenho, mais a linha sem campo', () => {
    const campos = new Set(TABELA.map((l) => l.campo));
    expect(campos.has(null)).toBe(true);
    const nomeados = [...campos].filter((c): c is string => c !== null).sort();
    expect(nomeados).toEqual([
      'attribute_list',
      'brand',
      'category_id',
      'description',
      'dimension',
      'gtin_code',
      'image',
      'item_id',
      'item_name',
      'logistic_info',
      'model_list',
      'original_price',
      'pre_order',
      'seller_stock',
      'shop',
      'size_chart_info',
      'standardise_tier_variation',
      'tax_info',
      'weight',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*            (1b) a tabela de medidas — `size_chart_info` (passo 18)          */
/* -------------------------------------------------------------------------- */

/** O erro que o transporte REALMENTE monta para um envelope de recusa. */
function doEnvelope(error: string, message: string, path: string): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: null, warning: null },
    { path, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

/** A frase do validador de IMAGEM, como as duas páginas de escrita a listam. */
const FRASE_DO_VALIDADOR = 'Upload failed, please upload a more standard size chart image.';

describe('tabela de medidas (passo 18)', () => {
  const fraseDoFio = (() => {
    const corpo = lerFixture(FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE);
    if (
      typeof corpo !== 'object' ||
      corpo === null ||
      Array.isArray(corpo) ||
      typeof corpo.message !== 'string'
    ) {
      throw new Error('a fixture da recusa não tem `message`');
    }
    return corpo.message;
  })();

  it('M73 — PAR: a frase COMMITADA da Shopee, pelo construtor real do erro, em add_item E update_item ⇒ size_chart_info com a NOSSA frase, nunca desconhecido', () => {
    for (const path of [SHOPEE_ADD_ITEM_PATH, SHOPEE_UPDATE_ITEM_PATH]) {
      const problemas = problemasDeErroShopee(doEnvelope('product.error_param', fraseDoFio, path));
      expect(problemas, path).toStrictEqual([
        {
          campo: 'size_chart_info',
          motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasRecusada,
          mensagem: MENSAGEM_TABELA_MEDIDAS_RECUSADA,
        },
      ]);
      // O inglês da Shopee (e o nosso prefixo técnico) NÃO chega ao operador:
      // ele não diz o que fazer — a frase nossa diz.
      expect(problemas[0]?.mensagem, path).not.toContain('Size chart');
      expect(problemas[0]?.mensagem, path).not.toContain('respondeu');
    }
  });

  it('a frase do modelo velho é a do Q4 do Lucas — pt-BR, e manda escolher outra em /medidas', () => {
    expect(MENSAGEM_TABELA_MEDIDAS_RECUSADA).toBe(
      'tabela de medidas recusada pela Shopee — escolha outra em /medidas',
    );
  });

  it('⛔ UMA regra (#1369): o que as ROTAS chamam de modelo inexistente é o que a publicação chama — nos DOIS sentidos', () => {
    // As rotas decidem com `classificarRecusaTabelaMedidas` (código `error_param`
    // + a frase CRUA da Shopee, dobrada). A publicação tinha uma segunda grafia
    // (trecho EXATO de `err.message`, qualquer código) que discordava dela.
    const casos: readonly {
      readonly rotulo: string;
      readonly code: string;
      readonly message: string;
      readonly tabela: boolean;
      /** Where a NON-template case lands instead — default: `desconhecido`. */
      readonly senao?: { readonly campo: string | null; readonly motivo: MotivoProblemaPublicacao };
    }[] = [
      // PAR — a rota diz "inexistente", e agora a publicação também.
      { rotulo: 'a frase do fio', code: 'product.error_param', message: fraseDoFio, tabela: true },
      {
        rotulo: 'minúscula',
        code: 'product.error_param',
        message: 'size chart id not exist in this shop',
        tabela: true,
      },
      {
        rotulo: 'com o prefixo "Wrong parameters, detail:"',
        code: 'product.error_param',
        message: 'Wrong parameters, detail: size chart id not exist in this shop.',
        tabela: true,
      },
      { rotulo: 'o código nu', code: 'error_param', message: fraseDoFio, tabela: true },
      // PAR — a frase do modelo AO LADO da frase de uma linha ANTERIOR da tabela:
      // a rota diz "inexistente", e nenhuma frase rouba o erro antes (a linha do
      // modelo é a PRIMEIRA).
      {
        rotulo: 'junto de "Image not exist." (linha imagens)',
        code: 'product.error_param',
        message: `Image not exist. ${fraseDoFio}`,
        tabela: true,
      },
      {
        rotulo: 'junto de "Invalid logistic info" (linha logística)',
        code: 'product.error_param',
        message: `Invalid logistic info; ${fraseDoFio}`,
        tabela: true,
      },
      // QUASE-PAR — a rota diz "não é isso", e agora a publicação também.
      {
        // …e a linha anterior volta a valer: a frase de imagens decide.
        rotulo: 'as duas frases sob error_data',
        code: 'product.error_data',
        message: `Image not exist. ${fraseDoFio}`,
        tabela: false,
        senao: { campo: 'image', motivo: 'sem-fotos' },
      },
      {
        rotulo: 'a mesma frase sob error_data',
        code: 'product.error_data',
        message: fraseDoFio,
        tabela: false,
      },
      {
        rotulo: 'dois segmentos de módulo',
        code: 'x.product.error_param',
        message: fraseDoFio,
        tabela: false,
      },
      {
        rotulo: 'a frase encurtada',
        code: 'product.error_param',
        message: 'Size chart not exist',
        tabela: false,
      },
      {
        // A OUTRA recusa que o classificador conhece — nunca um modelo velho.
        rotulo: 'a recusa da CATEGORIA',
        code: 'product.error_param',
        message: 'Category id is invalid',
        tabela: false,
      },
    ];
    for (const caso of casos) {
      const err = doEnvelope(caso.code, caso.message, SHOPEE_ADD_ITEM_PATH);
      const daRota =
        classificarRecusaTabelaMedidas(err) === MOTIVO_RECUSA_TABELA_MEDIDAS.tabelaInexistente;
      const [problema] = problemasDeErroShopee(err);
      const daPublicacao = problema?.motivo === MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasRecusada;
      expect(daRota, caso.rotulo).toBe(caso.tabela);
      expect(daPublicacao, caso.rotulo).toBe(caso.tabela);
      if (caso.tabela) {
        expect(problema, caso.rotulo).toStrictEqual({
          campo: 'size_chart_info',
          motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasRecusada,
          mensagem: MENSAGEM_TABELA_MEDIDAS_RECUSADA,
        });
      } else {
        expect(problema, caso.rotulo).toMatchObject(
          caso.senao ?? { campo: null, motivo: 'desconhecido' },
        );
      }
    }
  });

  it('⚠️ QUASE-PAR: a frase só em `err.message` (providerMessage null) NÃO é modelo velho — a regra lê a frase da SHOPEE', () => {
    const err = new ShopeeApiError(
      `Shopee ${SHOPEE_ADD_ITEM_PATH} respondeu product.error_param (HTTP 200) — ${fraseDoFio}`,
      { code: 'product.error_param', kind: 'other', httpStatus: 200, path: SHOPEE_ADD_ITEM_PATH },
    );
    expect(err.providerMessage).toBeNull();
    expect(classificarRecusaTabelaMedidas(err)).toBeNull();
    expect(problemasDeErroShopee(err)).toEqual([
      expect.objectContaining({ campo: null, motivo: 'desconhecido' }),
    ]);
  });

  it('a forma de TEXTO (código + frase) nunca decide o modelo velho — ela não tem o erro que a regra lê', () => {
    expect(problemaDeErroShopee('product.error_param', fraseDoFio)).toEqual({
      campo: null,
      motivo: 'desconhecido',
      mensagem: fraseDoFio,
    });
  });

  it('⛔ pelo CAMINHO REAL: o erro que `addItem`/`updateItem` do pacote LANÇAM (fetch → envelope → erro) cai nas duas linhas novas', async () => {
    // Ids de fixture e a chave inventada — nunca credenciais. O transporte é o
    // `shopeeCall` de verdade: só o `fetch` é dublê.
    function cliente(envelope: { readonly error: string; readonly message: string }) {
      return createShopeeClient({
        partnerId: 1000001,
        partnerKey: 'chave-de-teste-nao-e-credencial',
        hosts: resolveShopeeHosts({ sandbox: true }),
        shopId: 987654,
        getAccessToken: () => Promise.resolve('access-inventado'),
        now: () => 1_767_000_000_000,
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify({ request_id: 'req-1', warning: null, ...envelope }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          ),
      });
    }
    const criar = {
      item_name: 'Camiseta básica de algodão',
      description: 'Camiseta básica de algodão, corte reto, tamanhos P a GG.',
      original_price: 39.9,
      weight: 0.3,
      category_id: 100017,
      image: { image_id_list: ['img-1'] },
      logistic_info: [{ logistic_id: 90003, enabled: true }],
    };
    const casos = [
      {
        envelope: { error: 'product.error_param', message: fraseDoFio },
        motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasRecusada,
        info: { size_chart_id: 700024641 },
      },
      {
        envelope: { error: 'product.error_busi', message: FRASE_DO_VALIDADOR },
        motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasFotoRecusada,
        info: { size_chart: 'img-tabela-1' },
      },
    ] as const;

    for (const caso of casos) {
      const erros = [
        await cliente(caso.envelope)
          .addItem({ ...criar, size_chart_info: caso.info })
          .catch((e: unknown) => e),
        await cliente(caso.envelope)
          .updateItem({ item_id: 2500139861, size_chart_info: caso.info })
          .catch((e: unknown) => e),
      ];
      for (const erro of erros) {
        expect(erro).toBeInstanceOf(ShopeeApiError);
        const api = erro as ShopeeApiError;
        // O que o classificador lê (`err.message`) é a frase COMPOSTA do pacote —
        // e ela carrega a da Shopee verbatim, depois do caminho e do código.
        expect(api.message).toContain(` — ${caso.envelope.message}`);
        expect(api.providerMessage).toBe(caso.envelope.message);
        expect(problemasDeErroShopee(api), api.path).toEqual([
          expect.objectContaining({ campo: 'size_chart_info', motivo: caso.motivo }),
        ]);
        // ⚠️ UMA regra: o classificador das ROTAS concorda sobre o MESMO erro —
        // modelo velho para a primeira, "não é isso" para a foto.
        expect(
          classificarRecusaTabelaMedidas(api) === MOTIVO_RECUSA_TABELA_MEDIDAS.tabelaInexistente,
        ).toBe(caso.motivo === MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasRecusada);
        // ⚠️ PAR da foto (uma linha de FRASE): ler `providerMessage` daria a MESMA
        // família — o prefixo composto (caminho + código) não contém a frase.
        if (caso.motivo === MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasFotoRecusada) {
          expect(problemaDeErroShopee(api.code, api.providerMessage ?? '').motivo).toBe(
            caso.motivo,
          );
        }
      }
    }

    // ⚠️ QUASE-PAR: a mesma recusa SEM a frase da Shopee não vira tabela — o
    // casamento vem da prosa dela, nunca do nosso prefixo `Shopee <path> respondeu`.
    const semFrase = await cliente({ error: 'product.error_param', message: '' })
      .updateItem({ item_id: 2500139861, size_chart_info: { size_chart_id: 700024641 } })
      .catch((e: unknown) => e);
    expect(semFrase).toBeInstanceOf(ShopeeApiError);
    expect(problemasDeErroShopee(semFrase)).toEqual([
      expect.objectContaining({ campo: null, motivo: 'desconhecido' }),
    ]);
  });

  it('M-A6/M-A7 — a recusa do VALIDADOR da foto vai para size_chart_info com a NOSSA frase — nunca para `image`/`sem-fotos`', () => {
    for (const path of [SHOPEE_ADD_ITEM_PATH, SHOPEE_UPDATE_ITEM_PATH]) {
      const problemas = problemasDeErroShopee(
        doEnvelope('product.error_busi', FRASE_DO_VALIDADOR, path),
      );
      expect(problemas, path).toStrictEqual([
        {
          campo: 'size_chart_info',
          motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasFotoRecusada,
          mensagem: MENSAGEM_TABELA_MEDIDAS_FOTO_RECUSADA,
        },
      ]);
    }
    // A frase da Shopee ("Upload failed") NÃO chega: ela leria como falha das fotos do anúncio.
    expect(MENSAGEM_TABELA_MEDIDAS_FOTO_RECUSADA).not.toContain('Upload failed');
    expect(MENSAGEM_TABELA_MEDIDAS_FOTO_RECUSADA).toBe(
      'foto da tabela de medidas recusada pela Shopee — troque a primeira foto da tabela ou escolha um modelo em /medidas',
    );
  });

  it('⛔ QUASE-PARES da foto: sem "size chart", ou com o "Please" maiúsculo, NÃO é a família', () => {
    for (const quase of [
      'Upload failed, please upload a more standard image.',
      'Please upload a more standard size chart image',
      'Upload failed',
    ]) {
      expect(problemaDeErroShopee('product.error_busi', quase).motivo, quase).toBe('desconhecido');
    }
  });

  it('a frase da foto é um trecho EXATO da sentença documentada, e o modelo é o CLASSIFICADOR das rotas (nenhuma agulha aqui)', () => {
    expect(FRASE_TABELA_MEDIDAS_FOTO_RECUSADA).toBe(
      'please upload a more standard size chart image',
    );
    expect(FRASE_DO_VALIDADOR).toContain(FRASE_TABELA_MEDIDAS_FOTO_RECUSADA);
    expect(fraseDoFio).toContain(FRASE_TABELA_MEDIDAS_INEXISTENTE);

    const fonte = readFileSync(
      fileURLToPath(new URL('./problemasPublicacao.ts', import.meta.url)),
      'utf8',
    );
    // A regra é IMPORTADA, inteira — e a agulha nem a frase moram aqui, então
    // não há segunda grafia que possa divergir da rota.
    expect(fonte).toMatch(
      /import \{\s*MOTIVO_RECUSA_TABELA_MEDIDAS,\s*classificarRecusaTabelaMedidas,?\s*\} from '\.\.\/tabelaMedidas\/recusaTabelaMedidas';/,
    );
    expect(fonte).not.toContain('FRASE_TABELA_MEDIDAS_INEXISTENTE');
    expect(fonte).not.toContain('Size chart id not exist');
  });

  it('o MODELO é a PRIMEIRA linha da tabela (nenhuma frase o alcança antes); a FOTO fica logo depois de `imagens`', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./problemasPublicacao.ts', import.meta.url)),
      'utf8',
    );
    const inicio = fonte.indexOf('const FAMILIAS: readonly FamiliaProblema[] = [');
    const primeiraLinha = fonte.indexOf('rotulo: ', inicio);
    const imagens = fonte.indexOf("rotulo: 'imagens'");
    const modelo = fonte.indexOf("rotulo: 'tabela-de-medidas'");
    const foto = fonte.indexOf("rotulo: 'tabela-de-medidas-foto'");
    const preco = fonte.indexOf("rotulo: 'preco'");
    expect(inicio).toBeGreaterThan(-1);
    expect(imagens).toBeGreaterThan(-1);
    // A regra das rotas decide ANTES de qualquer linha de frase.
    expect(modelo).toBe(primeiraLinha);
    expect(imagens).toBeLessThan(foto);
    expect(foto).toBeLessThan(preco);
    const entreImagensEFoto = fonte.slice(imagens + 1, foto);
    expect(entreImagensEFoto).not.toContain('rotulo: ');
  });

  it('as mensagens FIXAS valem só para as DUAS linhas da tabela de medidas — toda outra linha segue com a prosa da Shopee', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./problemasPublicacao.ts', import.meta.url)),
      'utf8',
    );
    expect((fonte.match(/^\s+mensagem: MENSAGEM_\w+/gm) ?? []).map((l) => l.trim())).toEqual([
      'mensagem: MENSAGEM_TABELA_MEDIDAS_RECUSADA',
      'mensagem: MENSAGEM_TABELA_MEDIDAS_FOTO_RECUSADA',
    ]);
    // QUASE-PAR: a linha vizinha (`imagens`) entrega a prosa da Shopee, verbatim.
    expect(problemaDeErroShopee('error_image_num_min', 'at least one image').mensagem).toBe(
      'at least one image',
    );
  });

  it('a frase de uma foto que NÃO chegou à Shopee não a culpa — e manda tentar de novo primeiro', () => {
    expect(MENSAGEM_TABELA_MEDIDAS_FOTO_NAO_ENVIADA).toBe(
      'não foi possível enviar a foto da tabela de medidas — tente de novo; se repetir, troque a primeira foto ou escolha um modelo em /medidas',
    );
    expect(MENSAGEM_TABELA_MEDIDAS_FOTO_NAO_ENVIADA).not.toContain('Shopee');
  });
});

/* -------------------------------------------------------------------------- */
/*                  (2) o prefixo de módulo — PAR e QUASE-PAR                  */
/* -------------------------------------------------------------------------- */

describe('o prefixo de módulo', () => {
  it('⚠️ PAR: product.error_invalid_category e error_invalid_category classificam IGUAL', () => {
    const prefixado = problemaDeErroShopee('product.error_invalid_category', 'x');
    const nu = problemaDeErroShopee('error_invalid_category', 'x');
    expect(prefixado).toEqual(nu);
    expect(nu.motivo).toBe('categoria-invalida');
  });

  it('⚠️ PAR: qualquer módulo serve — logistics.error_invalid_logistic_info é a mesma família', () => {
    expect(problemaDeErroShopee('logistics.error_invalid_logistic_info', 'x').campo).toBe(
      'logistic_info',
    );
  });

  it('⚠️ QUASE-PAR: error_param com mensagem fora de toda família NÃO ganha campo nenhum', () => {
    expect(problemaDeErroShopee('error_param', 'uma prosa qualquer')).toEqual({
      campo: null,
      motivo: 'desconhecido',
      mensagem: 'uma prosa qualquer',
    });
  });

  it('⚠️ QUASE-PAR: a tira é de UM prefixo só — a.b.error_invalid_category não classifica', () => {
    expect(problemaDeErroShopee('a.b.error_invalid_category', 'x').motivo).toBe('desconhecido');
  });

  it('⚠️ QUASE-PAR: error.param (o typo da Shopee) não vira a família error_param', () => {
    // A tira devolve 'param', que não está em nenhuma família por CÓDIGO; só a
    // mensagem pode classificar.
    expect(problemaDeErroShopee('error.param', 'nada conhecido').campo).toBeNull();
    expect(problemaDeErroShopee('error.param', 'dimension is required').campo).toBe('dimension');
  });
});

/* -------------------------------------------------------------------------- */
/*                 (3) M-34 — as três grafias do bloqueio                      */
/* -------------------------------------------------------------------------- */

describe('M-34 — o bloqueio por promoção', () => {
  it.each([
    'error_cannt_edit_name_in_promotion',
    'error_in_item_promotion_name_item_lock',
    'error_model_update_name_model_in_promotion',
  ])('as TRÊS grafias do bloqueio por promoção classificam igual — %s', (code) => {
    expect(problemaDeErroShopee(code, 'item is in a promotion')).toEqual({
      campo: 'item_name',
      motivo: 'bloqueado-por-promocao',
      mensagem: 'item is in a promotion',
    });
  });

  it.each([
    { code: 'error_cannt_edit_description_in_promotion', campo: 'description' },
    { code: 'error_in_item_promotion_description_lock', campo: 'description' },
    { code: 'error_cannt_edit_image_in_promotion', campo: 'image' },
    { code: 'error_in_item_promotion_image_item_lock', campo: 'image' },
    { code: 'error_cannt_edit_stock_in_promotion', campo: 'seller_stock' },
    { code: 'error_cannt_change_tier_variation_in_promotion', campo: 'standardise_tier_variation' },
    { code: 'error_cannt_edit_pre_order_in_promotion', campo: 'pre_order' },
    { code: 'error_cannt_edit_estimated_days_in_promotion', campo: 'pre_order' },
  ])('o campo do bloqueio vem do substantivo do código — $code', ({ code, campo }) => {
    const p = problemaDeErroShopee(code, 'in promotion');
    expect(p.motivo).toBe('bloqueado-por-promocao');
    expect(p.campo).toBe(campo);
  });

  it.each([
    'error_item_in_promotion',
    'error_flash_sale_days_to_ship_lock',
    'error_cannt_delete_option_in_promotion',
    'error_cannt_be_no_variation_in_promotion',
  ])('um bloqueio sem substantivo conhecido fica sem campo — %s', (code) => {
    const p = problemaDeErroShopee(code, 'in promotion');
    expect(p.motivo).toBe('bloqueado-por-promocao');
    expect(p.campo).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                   (4) a ORDEM da tabela é carregada                         */
/* -------------------------------------------------------------------------- */

describe('a ordem da tabela', () => {
  it('error_item_in_promotion é CATEGORIA quando a mensagem diz isso, e promoção no resto', () => {
    expect(problemaDeErroShopee('error_item_in_promotion', 'can not set category')).toMatchObject({
      campo: 'category_id',
      motivo: 'categoria-invalida',
    });
    expect(problemaDeErroShopee('error_item_in_promotion', 'item locked')).toMatchObject({
      campo: null,
      motivo: 'bloqueado-por-promocao',
    });
  });

  it('a faixa da loja vence a família genérica de estoque quando a mensagem casa as duas', () => {
    const p = problemaDeErroShopee(
      'product.error_busi',
      'Stock should be within 2-1000000; stock less than reserve stock',
    );
    expect(p.motivo).toBe('estoque-abaixo-do-minimo');
  });
});

/* -------------------------------------------------------------------------- */
/*                   (5) o atributo nomeado na mensagem                        */
/* -------------------------------------------------------------------------- */

describe('o campo do atributo', () => {
  it('um token entre colchetes refina o campo', () => {
    expect(
      problemaDeErroShopee('error_less_required_attribute', 'attribute [COLOR_FAMILY] is required')
        .campo,
    ).toBe('attribute_list[COLOR_FAMILY]');
  });

  it('⚠️ QUASE-PAR: uma palavra em maiúsculas SEM colchetes não refina nada', () => {
    expect(
      problemaDeErroShopee('error_less_required_attribute', 'attribute COLOR is required').campo,
    ).toBe('attribute_list');
  });

  it('só o PRIMEIRO token entre colchetes decide — um campo é um caminho', () => {
    expect(
      problemaDeErroShopee('error_invalid_attribute', 'both [SIZE] and [COLOR] are wrong').campo,
    ).toBe('attribute_list[SIZE]');
  });
});

/* -------------------------------------------------------------------------- */
/*                 (6) o imposto NUNCA é imposto-incompleto                    */
/* -------------------------------------------------------------------------- */

describe('imposto', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('./problemasPublicacao.ts', import.meta.url)),
    'utf8',
  );

  it('a família tax_info classifica como imposto-recusado', () => {
    for (const mensagem of [
      FRASE_TAX_INFO_INCOMPLETO,
      'invalid additional information',
      'Please input the tax information becasue the category needs it',
    ]) {
      expect(problemaDeErroShopee('product.error_param', mensagem)).toMatchObject({
        campo: 'tax_info',
        motivo: 'imposto-recusado',
      });
    }
  });

  it('a palavra imposto-incompleto não existe no texto do módulo (C14)', () => {
    expect(fonte).toContain('imposto-recusado');
    expect(fonte).not.toContain('imposto-incompleto');
  });

  it('a frase do bloco BR é IMPORTADA, não copiada — uma grafia só no app', () => {
    expect(fonte).toContain('FRASE_TAX_INFO_INCOMPLETO');
    expect(fonte).not.toContain('all BR tax field');
  });
});

/* -------------------------------------------------------------------------- */
/*              (7) problemasDeErroShopee — o que NÃO é da listagem             */
/* -------------------------------------------------------------------------- */

describe('problemasDeErroShopee', () => {
  it('um ShopeeApiError kind "other" vira UM problema classificado', () => {
    const problemas = problemasDeErroShopee(
      apiError('product.error_invalid_category', 'category is invalid'),
    );
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toMatchObject({ campo: 'category_id', motivo: 'categoria-invalida' });
  });

  it.each([
    {
      rotulo: 'ShopeeRateLimitError (burst)',
      err: new ShopeeRateLimitError('limite', {
        code: 'error_service_unavailable',
        kind: 'burst' as const,
        httpStatus: 429,
        path: CAMINHO,
      }),
    },
    {
      rotulo: 'ShopeeRateLimitError (daily)',
      err: new ShopeeRateLimitError('limite', {
        code: 'error_max_api_call',
        kind: 'daily' as const,
        httpStatus: 200,
        path: CAMINHO,
      }),
    },
    {
      rotulo: 'ShopeeReauthRequiredError',
      err: new ShopeeReauthRequiredError('reconectar', {
        code: 'error_auth',
        kind: 'reauth' as const,
        httpStatus: 200,
        path: '/api/v2/auth/token/get',
      }),
    },
    { rotulo: 'ShopeeNetworkError', err: new ShopeeNetworkError('conexão caiu') },
    {
      rotulo: 'ShopeeHttpError',
      err: new ShopeeHttpError('html do edge', { httpStatus: 502, path: CAMINHO }),
    },
    {
      rotulo: 'ShopeeSchemaError',
      err: new ShopeeSchemaError('corpo estranho', {
        campos: ['error'],
        httpStatus: 200,
        path: CAMINHO,
      }),
    },
    {
      rotulo: 'um ShopeeApiError kind "transient"',
      err: new ShopeeApiError('instável', {
        code: 'error_inner',
        kind: 'transient' as const,
        httpStatus: 200,
        path: CAMINHO,
      }),
    },
    { rotulo: 'um Error qualquer', err: new Error('nada a ver') },
    { rotulo: 'null', err: null },
    { rotulo: 'uma string', err: 'error_param' },
  ])('$rotulo não é um problema da listagem — responde []', ({ err }) => {
    expect(problemasDeErroShopee(err)).toEqual([]);
  });

  it('a mensagem do problema carrega a prosa da Shopee que veio no erro', () => {
    const err = apiError('product.error_param', 'dimension is required');
    const problemas = problemasDeErroShopee(err);
    expect(problemas[0]?.campo).toBe('dimension');
    expect(problemas[0]?.mensagem).toContain('dimension is required');
  });
});

/* -------------------------------------------------------------------------- */
/*                        (8) o corte em 500 caracteres                        */
/* -------------------------------------------------------------------------- */

describe('o limite da mensagem', () => {
  it('uma mensagem gigante é cortada em 500 caracteres, nunca 501', () => {
    const gigante = 'x'.repeat(900);
    const p = problemaDeErroShopee('error_param', gigante);
    expect(p.mensagem).toHaveLength(500);
    expect(p.mensagem.endsWith('…')).toBe(true);
  });

  it('uma mensagem de 500 caracteres passa intacta', () => {
    const exata = 'y'.repeat(500);
    expect(problemaDeErroShopee('error_param', exata)).toMatchObject({ mensagem: exata });
  });
});

/* -------------------------------------------------------------------------- */
/*                        (9) disciplina do módulo                             */
/* -------------------------------------------------------------------------- */

describe('disciplina do módulo', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('./problemasPublicacao.ts', import.meta.url)),
    'utf8',
  );

  it('usa a tira de prefixo DO PACOTE e não declara nenhuma local (C3)', () => {
    const doPacote = fonte.match(/shopeeCodeSemPrefixoDeModulo/g) ?? [];
    const qualquer = fonte.match(/semPrefixoDeModulo/g) ?? [];
    // Toda menção à tira é a do pacote: o nome local começaria com `s` minúsculo.
    expect(doPacote.length).toBeGreaterThanOrEqual(2);
    expect(qualquer).toHaveLength(0);
    expect(fonte).toContain("from '@delfrance/integrations-shopee'");
  });

  it('não reimplementa a tira com uma regex, um split nem um indexOf', () => {
    expect(fonte).not.toMatch(/\/\^\[a-z/);
    expect(fonte).not.toContain(".split('.')");
    expect(fonte).not.toContain("indexOf('.')");
    expect(fonte).not.toMatch(/\.slice\(\s*\w*\.?\w*\.?(indexOf|length)/);
  });

  it('não declara o cap da mensagem nem nenhuma constante com o prefixo do pacote', () => {
    expect(fonte).toContain('limitarMensagemProblema');
    expect(fonte).not.toMatch(/export const SHOPEE_/);
    expect(fonte).not.toMatch(/const MAX_MENSAGEM_PROBLEMA/);
  });
});
