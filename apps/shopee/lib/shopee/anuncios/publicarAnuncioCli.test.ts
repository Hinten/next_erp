/**
 * The pure half of `publicar:anuncio` (#1519, step 11).
 *
 * ⚠️ Five of these are the only thing standing between a rehearsal and a leak,
 * a lie about the exit code, or a `--live` that fires by accident — and none of
 * them is a happy path:
 *
 *  - **§3** drives the summary over a plan that REALLY carries the seller
 *    description, an `image_id`, a url inside a photo-failure message and two
 *    `original_value_name`s, and asserts none of the five reaches the rendered
 *    lines OR the `--json` document — with a FIELD-COUNT pin beside it, so a
 *    field added to the allow-list has to be looked at rather than inherited;
 *  - **§4** pins the ONE deliberate divergence from step 9 (C34): the fiscal
 *    VALUES are printed — plus the near-miss, an omitted block that still
 *    prints its `chaves` line and names the motivo;
 *  - **§5** pins that a BLOCKED plan is an ANSWER: it renders its `problemas`
 *    and the script has no `exitCode` on that path, which is what the exit 0
 *    rests on;
 *  - **§6** pins that the SCRIPT names `publicarAnuncioShopee` only below the
 *    `live` branch — the one mutant a unit test of the pure half cannot see;
 *  - **§7** pins that a throw is described by CLASS plus Shopee's `code`, and
 *    never by a payload.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  SHOPEE_CONDITION,
  SHOPEE_ERROR_KIND,
  SHOPEE_ITEM_STATUS_WRITABLE,
  ShopeeApiError,
  shopeeCategoriaSchema,
  shopeeLogisticsChannelSchema,
  type ShopeeAddItemRequest,
  type ShopeeLogisticsChannel,
} from '@delfrance/integrations-shopee';

import { ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';

import type { AtributosProjetados } from '../taxonomia/dto';
import {
  ETAPA_PUBLICACAO,
  MOTIVO_PROBLEMA_PUBLICACAO,
  MOTIVO_PUBLICACAO_BLOQUEADA,
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
  type ProblemaDeBloqueio,
} from './errosPublicacao';
import { MOTIVO_FOTO_PUBLICACAO } from './fotosPublicacao';
import type { PlanoPublicacao } from './planoPublicacao';
import {
  ArgumentoInvalidoError,
  MSG_CATEGORIA_NAO_NUMERICA,
  MSG_STATUS_INVALIDO,
  USO_PUBLICAR_ANUNCIO,
  descreverErroPublicacao,
  lerArgsPublicar,
  renderizarPlano,
  renderizarResultado,
  resumoDaPublicacao,
  resumoDoResultado,
  type ContextoDoEnsaio,
} from './publicarAnuncioCli';
import type { ResultadoPublicacao } from './publicarAnuncio';
import { MOTIVO_TAX_INFO_OMITIDO } from './taxInfoPublicacao';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, item or seller.  */
/* -------------------------------------------------------------------------- */

/** The composition root, read as TEXT — the only way to see what it calls where. */
const FONTE_SCRIPT = readFileSync(
  new URL('../../../scripts/publicar-anuncio.ts', import.meta.url),
  'utf8',
);

const INTEGRACAO_ID = 'int-1';
const PRODUTO_ID = 'prod-pai-1';
const LINK_DOC_ID = 'link-1';
const ITEM_ID = 2500139861;
const MODEL_ID = 2000458802;
const CATEGORIA_ID = 100017;

/**
 * Each sentinel sits where the value it stands for REALLY lives in a plan, so
 * the absence assertions cannot pass vacuously. The one that does not (a token /
 * a partner key / a shop id) has no field to travel in at all, and §3's last
 * test pins that SHAPE instead.
 */
const SENTINELA_DESCRICAO = 'SENTINELA-DESCRICAO-AUTORAL-DO-VENDEDOR';
const SENTINELA_IMAGE_ID = 'SENTINELA-IMAGE-ID-DEVOLVIDO-PELA-SHOPEE';
const SENTINELA_URL_ARQUIVO = 'https://sentinela.invalido/arquivo-1.jpg';
const SENTINELA_VALOR_CUSTOM = 'SENTINELA-ORIGINAL-VALUE-NAME-CUSTOM';
const SENTINELA_VALOR_NAO_CUSTOM = 'SENTINELA-ORIGINAL-VALUE-NAME-NAO-CUSTOM';

const TAX_INFO = {
  ncm: '61091000',
  cest: '2806400',
  origin: '0',
  csosn: '102',
  pis: '1.65',
  cofins: '7.60',
  pis_cofins_cst: '01',
  same_state_cfop: '5102',
  diff_state_cfop: '6102',
  measure_unit: 'UN',
} as const;

/** The stored `link.attributes`, exactly as `montarAnuncio` read them. */
const ATRIBUTOS_ARMAZENADOS: readonly unknown[] = [
  {
    attribute_id: 100_182,
    attribute_value_list: [
      // CUSTOM (`value_id: 0`) — its name reaches the built body…
      { value_id: 0, original_value_name: SENTINELA_VALOR_CUSTOM },
    ],
  },
  {
    attribute_id: 100_183,
    attribute_value_list: [
      // …and a NON-custom one whose stored name the mapper drops outright.
      { value_id: 77_001, original_value_name: SENTINELA_VALOR_NAO_CUSTOM },
    ],
  },
];

function canais(): readonly ShopeeLogisticsChannel[] {
  return [
    shopeeLogisticsChannelSchema.parse({
      logistics_channel_id: 90_003,
      logistics_channel_name: 'Envio econômico',
      enabled: true,
      fee_type: 'SIZE_SELECTION',
      has_children: false,
    }),
    shopeeLogisticsChannelSchema.parse({
      logistics_channel_id: 90_021,
      logistics_channel_name: 'Coleta',
      enabled: true,
      fee_type: 'FIXED_DEFAULT_PRICE',
      has_children: false,
    }),
  ];
}

function atributosProjetados(): AtributosProjetados {
  return {
    truncated: false,
    atributos: [
      {
        attributeId: 100_182,
        mandatory: true,
        name: 'Material',
        attributeInfo: null,
        attributeValueList: [],
      },
      {
        attributeId: 100_183,
        mandatory: false,
        name: 'Estampa',
        attributeInfo: null,
        attributeValueList: [],
      },
      {
        attributeId: 100_184,
        // The mandatory one with NO stored value — its NAME is the allow-listed
        // half of `atributo-obrigatorio`.
        mandatory: true,
        name: 'Gramatura',
        attributeInfo: null,
        attributeValueList: [],
      },
    ],
  };
}

function contexto(): ContextoDoEnsaio {
  return {
    integracaoId: INTEGRACAO_ID,
    canais: canais(),
    atributos: atributosProjetados(),
    link: { attributes: ATRIBUTOS_ARMAZENADOS },
    veredictoFolha: 'folha',
    categoria: [
      shopeeCategoriaSchema.parse({
        category_id: 100_001,
        parent_category_id: 0,
        display_category_name: 'Moda Feminina',
        has_children: true,
      }),
      shopeeCategoriaSchema.parse({
        category_id: CATEGORIA_ID,
        parent_category_id: 100_001,
        display_category_name: 'Camisetas',
        has_children: false,
      }),
    ],
  };
}

function corpoCriar(): ShopeeAddItemRequest {
  return {
    item_name: 'Camiseta Delfrance Básica',
    description: SENTINELA_DESCRICAO,
    original_price: 79.9,
    weight: 0.32,
    category_id: CATEGORIA_ID,
    image: { image_id_list: [SENTINELA_IMAGE_ID, `${SENTINELA_IMAGE_ID}-2`] },
    logistic_info: [
      { logistic_id: 90_003, enabled: true, is_free: false, size_id: 3 },
      { logistic_id: 90_021, enabled: true, is_free: true },
    ],
    item_status: SHOPEE_ITEM_STATUS_WRITABLE.unlist,
    condition: SHOPEE_CONDITION.new,
    dimension: { package_height: 4, package_width: 22, package_length: 30 },
    attribute_list: [
      {
        attribute_id: 100_182,
        attribute_value_list: [{ value_id: 0, original_value_name: SENTINELA_VALOR_CUSTOM }],
      },
      { attribute_id: 100_183, attribute_value_list: [{ value_id: 77_001 }] },
    ],
    brand: { brand_id: 0, original_brand_name: 'No Brand' },
    item_sku: 'CAM-BAS',
    gtin_code: '7891234567895',
    seller_stock: [{ stock: 0 }],
    pre_order: { is_pre_order: false },
    tax_info: { ...TAX_INFO },
    description_type: 'normal',
  };
}

/** A plan for a create WITH children, blocked by nothing. */
function plano(over: Partial<PlanoPublicacao> = {}): PlanoPublicacao {
  const criar = corpoCriar();
  const base: PlanoPublicacao = {
    produtoId: PRODUTO_ID,
    linkDocId: LINK_DOC_ID,
    itemId: null,
    ehAtualizacao: false,
    temFilhos: true,
    statusPedido: SHOPEE_ITEM_STATUS_WRITABLE.normal,
    statusInicial: SHOPEE_ITEM_STATUS_WRITABLE.unlist,
    item: { criar, atualizar: null, problemas: [] },
    tiers: [
      {
        grupoId: 'grupo-cor',
        variation_id: 0,
        variation_group_id: null,
        variation_name: 'Cor',
        opcoes: [
          {
            varianteId: 'var-azul',
            variation_option_id: 0,
            variation_option_name: 'Azul',
            image_id: SENTINELA_IMAGE_ID,
            ocupadaPorModeloSemFilho: false,
          },
          {
            varianteId: null,
            variation_option_id: 0,
            variation_option_name: 'Verde',
            image_id: null,
            ocupadaPorModeloSemFilho: true,
          },
        ],
      },
    ],
    modelos: {
      acao: 'init',
      mudouProfundidade: false,
      modelList: [{ model_id: MODEL_ID, tier_index: [0] }],
      novos: [
        {
          produtoId: 'prod-filho-1',
          linkDocId: null,
          tier_index: [0],
          original_price: 79.9,
          seller_stock: [{ stock: 7 }],
          model_sku: 'CAM-BAS-AZ',
        },
      ],
      atualizarSku: [{ model_id: MODEL_ID, model_sku: 'CAM-BAS-AZ' }],
      modelosSemFilho: [{ model_id: MODEL_ID + 1, tier_index: [1], model_sku: null }],
      desaparecidos: [{ produtoId: 'prod-filho-9', linkDocId: 'link-9', modelId: MODEL_ID + 2 }],
    },
    modelosEntrada: {
      integracaoId: INTEGRACAO_ID,
      produtoPaiId: PRODUTO_ID,
      categoryId: CATEGORIA_ID,
      grupos: [],
      filhos: [],
      bandaDeEstoque: null,
      imagensDeOpcao: null,
      armazenados: [],
    },
    logistica: {
      logistic_info: criar.logistic_info,
      canaisHabilitados: [90_003, 90_021],
      pulados: [{ logisticId: 90_007, motivo: 'peso-fora-do-limite' }],
      problemas: [],
    },
    taxInfoOmitido: null,
    fotos: {
      item: {
        imageIds: [SENTINELA_IMAGE_ID, `${SENTINELA_IMAGE_ID}-2`],
        reutilizadas: 1,
        enviadas: 1,
        falhas: [],
        consideradas: 3,
        descartadasPeloLimite: 0,
      },
      imagensDeOpcao: null,
      resumo: {
        consideradas: 3,
        reutilizadas: 1,
        enviadas: 1,
        falhas: 1,
        descartadasPeloLimite: 0,
      },
    },
    falhasDeFoto: [
      {
        arquivoId: 'arq-3',
        motivo: MOTIVO_FOTO_PUBLICACAO.http,
        // ⚠️ The ONE place a url can still reach a plan — and the summary drops
        // this whole field, which is exactly what the sentinel proves.
        mensagem: `a origem respondeu 404 para ${SENTINELA_URL_ARQUIVO}`,
      },
    ],
    relistagem: ['unlist', 'update'],
    passos: [
      { tipo: 'fotos', enviadas: 1, reutilizadas: 1 },
      { tipo: 'add_item', statusInicial: SHOPEE_ITEM_STATUS_WRITABLE.unlist },
      { tipo: 'esperar', ms: 5_000 },
      { tipo: 'init_tier_variation', tiers: 1, modelos: 1 },
      { tipo: 'get_model_list' },
      { tipo: 'relistagem', ordem: ['unlist', 'update'] },
      { tipo: 'leitura-de-volta' },
    ],
    problemas: [],
  };
  return { ...base, ...over };
}

const BLOQUEIO: ProblemaDeBloqueio = {
  campo: 'weight',
  motivo: MOTIVO_PUBLICACAO_BLOQUEADA.semPeso,
  mensagem: 'o produto não tem peso bruto nem líquido utilizável',
};

function resultado(over: Partial<ResultadoPublicacao> = {}): ResultadoPublicacao {
  const p = plano();
  const base: ResultadoPublicacao = {
    plano: p,
    produtoId: PRODUTO_ID,
    itemId: ITEM_ID,
    linkDocId: LINK_DOC_ID,
    ehAtualizacao: false,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    itemStatus: 'NORMAL',
    deboost: false,
    avisoShopee: 'partial success',
    modelos: {
      acao: 'init',
      total: 2,
      criados: 1,
      repontados: 1,
      atualizados: 1,
      marcados: 0,
      semFilho: [{ model_id: MODEL_ID + 1, model_sku: null }],
      desaparecidos: [],
      ignorados: 0,
      avisos: ['partial success'],
      passos: [],
    },
    fotos: { consideradas: 3, reutilizadas: 1, enviadas: 1, falhas: 1, descartadasPeloLimite: 0 },
    falhasDeFoto: p.falhasDeFoto,
    taxInfoOmitido: null,
    relistagem: 'unlist',
    avisoResolvido: true,
    leituraDeVolta: true,
    chamadasShopee: 7,
  };
  return { ...base, ...over };
}

/* ========================================================================== */
/*  1 · lerArgsPublicar                                                       */
/* ========================================================================== */

describe('lerArgsPublicar', () => {
  it('lê as duas obrigatórias e devolve os padrões: dry-run, NORMAL, sem link', () => {
    const cmd = lerArgsPublicar(['--integracao', INTEGRACAO_ID, '--produto', PRODUTO_ID]);
    expect(cmd).toEqual({
      kind: 'publicar',
      args: {
        integracaoId: INTEGRACAO_ID,
        produtoId: PRODUTO_ID,
        linkDocId: null,
        categoryId: null,
        status: SHOPEE_ITEM_STATUS_WRITABLE.normal,
        live: false,
        json: false,
        projectId: null,
      },
    });
  });

  it('lê todas as opções, nas duas grafias (espaço e "=")', () => {
    const cmd = lerArgsPublicar([
      `--integracao=${INTEGRACAO_ID}`,
      '--produto',
      PRODUTO_ID,
      '--link',
      LINK_DOC_ID,
      `--categoria=${String(CATEGORIA_ID)}`,
      '--status',
      'UNLIST',
      '--json',
      '--live',
      '--project',
      'demo-erp',
    ]);
    expect(cmd).toEqual({
      kind: 'publicar',
      args: {
        integracaoId: INTEGRACAO_ID,
        produtoId: PRODUTO_ID,
        linkDocId: LINK_DOC_ID,
        categoryId: CATEGORIA_ID,
        status: SHOPEE_ITEM_STATUS_WRITABLE.unlist,
        live: true,
        json: true,
        projectId: 'demo-erp',
      },
    });
  });

  it('--help responde ANTES de qualquer validação, e -h também', () => {
    expect(lerArgsPublicar(['--help'])).toEqual({ kind: 'ajuda' });
    expect(lerArgsPublicar(['-h'])).toEqual({ kind: 'ajuda' });
    // Nenhuma das recusas abaixo pode preceder a ajuda.
    expect(lerArgsPublicar(['--live', '--dry-run', '--help'])).toEqual({ kind: 'ajuda' });
    expect(lerArgsPublicar(['--sei-la', '-h'])).toEqual({ kind: 'ajuda' });
  });

  it.each([
    ['--integracao', ['--integracao', '', '--produto', PRODUTO_ID]],
    ['--produto', ['--integracao', INTEGRACAO_ID, '--produto', 'documents/produto/p1']],
    ['--link', ['--integracao', INTEGRACAO_ID, '--produto', PRODUTO_ID, '--link', 'a/b/c']],
  ])('%s recusa o que não é id de documento', (_nome, argv) => {
    expect(() => lerArgsPublicar(argv)).toThrow(ArgumentoInvalidoError);
  });

  it('⚠️ "a/b/c" é o caso que NÃO lança no Firestore — resolve outro documento', () => {
    // O `.doc('a/b/c')` do admin não reclama: ele aponta dois níveis abaixo da
    // coleção que queríamos, e o operador recebe um 404 sem explicação.
    expect(() => lerArgsPublicar(['--integracao', INTEGRACAO_ID, '--produto', 'a/b/c'])).toThrow(
      /não é um id de documento/,
    );
  });

  it('--status aceita só NORMAL e UNLIST — sem alias e sem case fold', () => {
    for (const aceito of Object.values(SHOPEE_ITEM_STATUS_WRITABLE)) {
      const cmd = lerArgsPublicar([
        '--integracao',
        INTEGRACAO_ID,
        '--produto',
        PRODUTO_ID,
        '--status',
        aceito,
      ]);
      expect(cmd.kind === 'publicar' && cmd.args.status).toBe(aceito);
    }
    // ⚠️ NEAR-MISS: a grafia minúscula é OUTRO valor nesta wire.
    for (const recusado of ['unlist', 'normal', 'BANNED', 'SELLER_DELETE', '']) {
      expect(() =>
        lerArgsPublicar([
          '--integracao',
          INTEGRACAO_ID,
          '--produto',
          PRODUTO_ID,
          '--status',
          recusado,
        ]),
      ).toThrow(ArgumentoInvalidoError);
    }
    expect(MSG_STATUS_INVALIDO).toContain('NORMAL');
    expect(MSG_STATUS_INVALIDO).toContain('UNLIST');
  });

  it('--categoria exige dígitos puros, e um inteiro positivo dentro do seguro', () => {
    for (const bruto of [' 100017', '100017 ', '+100017', '100.017', '100,017', 'abc']) {
      expect(() =>
        lerArgsPublicar([
          '--integracao',
          INTEGRACAO_ID,
          '--produto',
          PRODUTO_ID,
          '--categoria',
          bruto,
        ]),
      ).toThrow(MSG_CATEGORIA_NAO_NUMERICA);
    }
    // ⚠️ NEAR-MISS: `0` passa no teste de dígitos e não é categoria nenhuma; e
    // uma corrida de dígitos longa demais publicaria sob OUTRA categoria.
    for (const bruto of ['0', '999999999999999999999']) {
      expect(() =>
        lerArgsPublicar([
          '--integracao',
          INTEGRACAO_ID,
          '--produto',
          PRODUTO_ID,
          '--categoria',
          bruto,
        ]),
      ).toThrow(/não é um category_id utilizável/);
    }
  });

  it('--live com --dry-run é RECUSADO, nunca resolvido por precedência', () => {
    expect(() =>
      lerArgsPublicar([
        '--integracao',
        INTEGRACAO_ID,
        '--produto',
        PRODUTO_ID,
        '--live',
        '--dry-run',
      ]),
    ).toThrow(/contraditórios/);
  });

  it('uma opção desconhecida e o separador "--" são recusados', () => {
    expect(() => lerArgsPublicar(['--integracao', INTEGRACAO_ID, '--sei-la'])).toThrow(
      /Opção desconhecida/,
    );
    expect(() => lerArgsPublicar(['--', '--integracao', INTEGRACAO_ID])).toThrow(/Separador/);
  });
});

/* ========================================================================== */
/*  2 · o plano renderizado — a lista permitida inteira                       */
/* ========================================================================== */

describe('renderizarPlano — a lista permitida do design-P2 §10.3', () => {
  const texto = renderizarPlano(plano(), contexto()).join('\n');

  it.each([
    ['item_id (novo)', 'novo'],
    ['category_id', String(CATEGORIA_ID)],
    ['o CAMINHO resolvido da categoria', 'Moda Feminina > Camisetas'],
    ['item_name', 'Camiseta Delfrance Básica'],
    ['o TAMANHO da descrição', `${String(SENTINELA_DESCRICAO.length)} caractere(s)`],
    ['condition', SHOPEE_CONDITION.new],
    ['weight', '0.32 kg'],
    ['a trinca dimension', '4×22×30 cm'],
    ['brand', '0 "No Brand"'],
    ['attribute_id + contagem de valores', 'attribute_id 100182'],
    ['os NOMES dos obrigatórios sem valor', 'Gramatura'],
    ['uma linha de logistic_info com o fee_type', 'fee_type=SIZE_SELECTION'],
    ['o canal pulado com seu motivo', 'peso-fora-do-limite'],
    ['pre_order', 'pre_order'],
    ['gtin_code', '7891234567895'],
    ['a tabela de tiers', 'variation_id=0'],
    ['a tabela de modelos', 'CAM-BAS-AZ'],
    ['as fotos como CONTAGEM', '3 consideradas'],
    ['modelosSemFilho', String(MODEL_ID + 1)],
    ['os passos que o --live executaria', 'init_tier_variation'],
  ])('imprime %s', (_o, trecho) => {
    expect(texto).toContain(trecho);
  });

  it('diz que o produto é publicável quando não há problema nenhum', () => {
    expect(texto).toContain('problemas: NENHUM');
  });

  it('a sequência e os dois status saem separados — pedido ≠ o que o add_item envia', () => {
    // ⚠️ Um create COM filhos publica UNLIST e re-lista depois; imprimir só um
    // dos dois faria a rehearsal parecer que o operador pediu pausado.
    expect(texto).toContain('sequência create');
    expect(texto).toContain(`pedido=${SHOPEE_ITEM_STATUS_WRITABLE.normal}`);
    expect(texto).toContain(`add_item envia=${SHOPEE_ITEM_STATUS_WRITABLE.unlist}`);
  });

  it('o resumo tem um conjunto de campos FIXO — um campo novo tem de ser olhado', () => {
    expect(Object.keys(resumoDaPublicacao(plano(), contexto())).sort()).toEqual(
      [
        'atributos',
        'atributosFaltando',
        'brand',
        'canaisPulados',
        'categoriaCaminho',
        'categoryId',
        'condition',
        'descricaoChars',
        'dimension',
        'fotos',
        'gtinCode',
        'imagens',
        'itemId',
        'itemName',
        'itemNameChars',
        'itemSku',
        'linkDocId',
        'logistica',
        'modelos',
        'passos',
        'preOrder',
        'problemas',
        'produtoId',
        'relistagem',
        'sequencia',
        'statusInicial',
        'statusPedido',
        'taxInfo',
        'tiers',
        'veredictoFolha',
        'weight',
      ].sort(),
    );
  });
});

/* ========================================================================== */
/*  3 · a redação é uma ALLOW-LIST                                            */
/* ========================================================================== */

describe('a redação é uma ALLOW-LIST', () => {
  const p = plano();
  const ctx = contexto();
  const resumo = resumoDaPublicacao(p, ctx);
  const comoTexto = renderizarPlano(p, ctx).join('\n');
  const comoJson = JSON.stringify(resumo);

  it.each([
    ['a description do vendedor', SENTINELA_DESCRICAO],
    ['um image_id', SENTINELA_IMAGE_ID],
    ['uma URL de arquivo (ela só existe na mensagem da falha de foto)', SENTINELA_URL_ARQUIVO],
    ['o original_value_name de um valor CUSTOM', SENTINELA_VALOR_CUSTOM],
    ['o original_value_name de um valor NÃO custom', SENTINELA_VALOR_NAO_CUSTOM],
  ])('⛔ NÃO carrega %s', (_o, sentinela) => {
    expect(comoTexto).not.toContain(sentinela);
    expect(comoJson).not.toContain(sentinela);
  });

  it('…e cada sentinela REALMENTE está no plano — nenhuma dessas ausências é vazia', () => {
    expect(p.item.criar.description).toBe(SENTINELA_DESCRICAO);
    expect(p.item.criar.image.image_id_list).toContain(SENTINELA_IMAGE_ID);
    expect(p.falhasDeFoto[0]?.mensagem).toContain(SENTINELA_URL_ARQUIVO);
    expect(JSON.stringify(p.item.criar.attribute_list)).toContain(SENTINELA_VALOR_CUSTOM);
    expect(JSON.stringify(ATRIBUTOS_ARMAZENADOS)).toContain(SENTINELA_VALOR_NAO_CUSTOM);
  });

  it('⛔ nenhuma linha nomeia token, partner_key, shop_id ou segredo', () => {
    // ⚠️ Estes quatro não têm campo por onde viajar: o plano não carrega nenhum
    // deles. O que este teste prende é a FORMA — no dia em que um chegar ao
    // plano, ele não passa por aqui de graça.
    expect(comoTexto).not.toMatch(/token|partner_key|partner_id|shop_id|secret/i);
    expect(comoJson).not.toMatch(/token|partner_key|partner_id|shop_id|secret/i);
    expect(comoTexto).not.toContain('https://');
  });

  it('a descrição vira CONTAGEM e o texto é dito REDIGIDO', () => {
    expect(resumo.descricaoChars).toBe(SENTINELA_DESCRICAO.length);
    expect(comoTexto).toContain('REDIGIDA');
  });

  it('a falha de foto sai como arquivoId + motivo fechado, nunca como mensagem', () => {
    expect(resumo.fotos.falhas).toEqual([
      { arquivoId: 'arq-3', motivo: MOTIVO_FOTO_PUBLICACAO.http },
    ]);
    expect(comoTexto).toContain('falha: arquivo arq-3');
    expect(comoTexto).toContain(MOTIVO_FOTO_PUBLICACAO.http);
  });

  it('as imagens saem como CONTAGEM e os atributos como número de valores', () => {
    expect(resumo.imagens).toBe(2);
    expect(resumo.atributos).toEqual([
      { attributeId: 100_182, valores: 1, mandatory: true },
      { attributeId: 100_183, valores: 1, mandatory: false },
    ]);
    expect(resumo.atributosFaltando).toEqual(['Gramatura']);
  });

  it('⛔ o resultado do --live é montado por NOME — o plano inteiro não vaza', () => {
    // ⚠️ `ResultadoPublicacao` carrega o `plano` inteiro: um `JSON.stringify` do
    // resultado cru imprimiria a descrição, os image_id e os valores de atributo.
    const res = resultado();
    expect(JSON.stringify(res)).toContain(SENTINELA_DESCRICAO);
    const redigido = JSON.stringify(resumoDoResultado(res));
    for (const sentinela of [
      SENTINELA_DESCRICAO,
      SENTINELA_IMAGE_ID,
      SENTINELA_URL_ARQUIVO,
      SENTINELA_VALOR_CUSTOM,
    ]) {
      expect(redigido).not.toContain(sentinela);
    }
    expect(renderizarResultado(res).join('\n')).not.toContain(SENTINELA_DESCRICAO);
  });

  it('o --json passa por JSON.parse e chega ao mesmo objeto redigido', () => {
    const voltou: unknown = JSON.parse(comoJson);
    expect(voltou).toEqual(JSON.parse(JSON.stringify(resumo)));
    expect(JSON.stringify(voltou)).not.toContain(SENTINELA_DESCRICAO);
  });
});

/* ========================================================================== */
/*  4 · tax_info — a divergência deliberada (C34)                             */
/* ========================================================================== */

describe('tax_info imprime CHAVES e VALORES (C34)', () => {
  const texto = renderizarPlano(plano(), contexto()).join('\n');

  it('⚠️ PAR: cada um dos dez campos fiscais sai com o seu valor', () => {
    // ⚠️ A divergência do `importar:anuncio`, que imprime só as chaves: um
    // NCM/CFOP/CSOSN é código de catálogo, e "a Shopee recusou o bloco fiscal"
    // não tem resposta sem ver o valor que saiu.
    for (const [chave, valor] of Object.entries(TAX_INFO)) {
      // A LINHA inteira, chave e valor — `toContain(valor)` sozinho passaria de
      // graça para um `origin` que vale '0'.
      expect(texto).toContain(`${chave.padEnd(22)} ${valor}`);
    }
    expect(texto).toContain('ENVIADO inteiro');
    expect(resumoDaPublicacao(plano(), contexto()).taxInfo.campos).toHaveLength(10);
  });

  it('⚠️ NEAR-MISS: o bloco OMITIDO ainda imprime a linha de chaves e NOMEIA o motivo', () => {
    const semImposto = plano({
      item: {
        criar: { ...corpoCriar(), tax_info: undefined },
        atualizar: null,
        problemas: [],
      },
      taxInfoOmitido: MOTIVO_TAX_INFO_OMITIDO.semOperacao,
    });
    const linhas = renderizarPlano(semImposto, contexto()).join('\n');
    const secao = linhas.slice(linhas.indexOf('### tax_info'), linhas.indexOf('### logistic_info'));
    expect(secao).toContain('chaves');
    expect(secao).toContain('(nenhum)');
    expect(secao).toContain(`omitido (${MOTIVO_TAX_INFO_OMITIDO.semOperacao})`);
    // …e nenhum valor fiscal ficou para trás na seção.
    for (const [chave, valor] of Object.entries(TAX_INFO)) {
      expect(secao).not.toContain(`${chave.padEnd(22)} ${valor}`);
    }
    expect(resumoDaPublicacao(semImposto, contexto()).taxInfo).toEqual({
      enviado: false,
      omitido: MOTIVO_TAX_INFO_OMITIDO.semOperacao,
      campos: [],
    });
  });
});

/* ========================================================================== */
/*  5 · um plano BLOQUEADO é uma RESPOSTA (o exit 0)                          */
/* ========================================================================== */

describe('um plano bloqueado', () => {
  const bloqueado = plano({ problemas: [BLOQUEIO] });

  it('renderiza os problemas inteiros e diz que NADA seria enviado', () => {
    const texto = renderizarPlano(bloqueado, contexto()).join('\n');
    expect(texto).toContain('### problemas (1) — NADA seria enviado');
    expect(texto).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.semPeso);
    expect(texto).toContain(BLOQUEIO.mensagem);
    expect(texto).not.toContain('problemas: NENHUM');
  });

  it('⚠️ o SCRIPT não marca exitCode em plano nenhum — é nisso que o exit 0 se apoia', () => {
    // Um teste unitário do meio puro não consegue ver isto: o código de saída é
    // do script. O ramo do dry-run vai de `if (!live) {` até o `return;` que
    // fecha a impressão, e a única marcação de saída que ele contém é a do
    // produto NÃO ENCONTRADO — nunca a de um plano com problemas.
    const ramo = FONTE_SCRIPT.slice(
      FONTE_SCRIPT.indexOf('if (!live) {'),
      FONTE_SCRIPT.indexOf('/* ---------------------------------- live'),
    );
    expect(ramo.length).toBeGreaterThan(0);
    expect(ramo).toContain('renderizarPlano');
    expect(ramo).toContain('plano.problemas.length === 0');
    // Uma única marcação, e ela é a do 404.
    expect(ramo.match(/process\.exitCode/g)).toHaveLength(1);
    expect(ramo).toContain('não encontrado');
  });
});

/* ========================================================================== */
/*  6 · o script: --live só dentro do ramo live                               */
/* ========================================================================== */

describe('scripts/publicar-anuncio.ts', () => {
  it('⛔ só chama publicarAnuncioShopee DEPOIS do ramo do dry-run', () => {
    // O mutante é mover a chamada para o caminho padrão: uma rehearsal passaria
    // a criar anúncio de verdade sem ninguém pedir `--live`.
    const guarda = FONTE_SCRIPT.indexOf('if (!live) {');
    const chamada = FONTE_SCRIPT.indexOf('await publicarAnuncioShopee(');
    expect(guarda).toBeGreaterThan(0);
    expect(chamada).toBeGreaterThan(guarda);
    // …e ela acontece UMA vez só.
    expect(FONTE_SCRIPT.match(/await publicarAnuncioShopee\(/g)).toHaveLength(1);
  });

  it('o dry-run chama prepararPublicacao e planejarPublicacao, e nenhum escritor', () => {
    expect(FONTE_SCRIPT).toContain('await prepararPublicacao(');
    expect(FONTE_SCRIPT).toContain('planejarPublicacao(');
    expect(FONTE_SCRIPT).toContain('await resolverFotosDaPublicacao(');
    expect(FONTE_SCRIPT).not.toContain('aplicarPublicacao(');
  });

  it('devolve na ajuda ANTES do primeiro await import', () => {
    const ajuda = FONTE_SCRIPT.indexOf("comando.kind === 'ajuda'");
    const primeiroImport = FONTE_SCRIPT.indexOf('await import(');
    expect(ajuda).toBeGreaterThan(0);
    expect(primeiroImport).toBeGreaterThan(0);
    expect(ajuda).toBeLessThan(primeiroImport);
  });

  it('o texto de uso NÃO documenta o separador "--" e não carrega id real', () => {
    // `pnpm-run-args.test.js` derruba a CI nessa grafia, e o comando morreria no
    // próprio separador.
    expect(USO_PUBLICAR_ANUNCIO).not.toMatch(/pnpm .*[^ ] -- +-/);
    expect(USO_PUBLICAR_ANUNCIO).toContain('publicar:anuncio');
    expect(USO_PUBLICAR_ANUNCIO).toContain('É o PADRÃO');
    expect(USO_PUBLICAR_ANUNCIO).not.toMatch(/partner_key|shop_id|token|secret/i);
  });
});

/* ========================================================================== */
/*  7 · o caminho do exit 1: classe + code, nunca payload                     */
/* ========================================================================== */

describe('descreverErroPublicacao', () => {
  it('um bloqueio é descrito por CLASSE + motivo, e promete que nada foi enviado', () => {
    const linhas = descreverErroPublicacao(
      new ShopeePublishBlockedError({
        produtoId: PRODUTO_ID,
        itemId: null,
        problemas: [
          {
            campo: null,
            motivo: MOTIVO_PUBLICACAO_BLOQUEADA.produtoEFilho,
            mensagem: 'este produto é uma variação; publique o pai',
          },
        ],
      }),
    );
    const texto = linhas.join('\n');
    expect(linhas[0]).toBe(
      `❌ ShopeePublishBlockedError (${MOTIVO_PUBLICACAO_BLOQUEADA.produtoEFilho})`,
    );
    expect(texto).toContain(PRODUTO_ID);
    expect(texto).toContain('novo (primeira publicação)');
    expect(texto).toContain('a recusa é anterior');
  });

  it('uma recusa da Shopee nomeia a ETAPA e o code — e NÃO promete que nada foi enviado', () => {
    const linhas = descreverErroPublicacao(
      new ShopeePublishRejectedError({
        etapa: ETAPA_PUBLICACAO.initTierVariation,
        shopeeCode: 'product.error_param',
        produtoId: PRODUTO_ID,
        itemId: ITEM_ID,
        problemas: [
          {
            campo: 'tier_variation',
            motivo: MOTIVO_PROBLEMA_PUBLICACAO.desconhecido,
            mensagem: 'Model tier_index error',
          },
        ],
      }),
    );
    const texto = linhas.join('\n');
    expect(linhas[0]).toBe(`❌ ShopeePublishRejectedError (${ETAPA_PUBLICACAO.initTierVariation})`);
    expect(texto).toContain('product.error_param');
    expect(texto).toContain(String(ITEM_ID));
    // ⚠️ NEAR-MISS do bloqueio: aqui um anúncio PODE já existir.
    expect(texto).not.toContain('a recusa é anterior');
    expect(texto).toContain('Escritas ANTERIORES podem ter acontecido');
  });

  it('um erro da Shopee sai por CLASSE + code/path, sem corpo nenhum', () => {
    const linhas = descreverErroPublicacao(
      new ShopeeApiError('Shopee /api/v2/product/add_item respondeu error_param (HTTP 200)', {
        code: 'error_param',
        kind: SHOPEE_ERROR_KIND.other,
        httpStatus: 200,
        path: '/api/v2/product/add_item',
        requestId: 'req-1',
      }),
    );
    const texto = linhas.join('\n');
    expect(linhas[0]).toBe(`❌ ShopeeApiError (${SHOPEE_ERROR_KIND.other})`);
    expect(texto).toContain('code=error_param');
    expect(texto).toContain('path=/api/v2/product/add_item');
    expect(texto).not.toMatch(/token|partner_key|shop_id/i);
  });

  it('um argumento inválido imprime a ajuda deste comando, não a de outro', () => {
    const texto = descreverErroPublicacao(
      new ArgumentoInvalidoError('--produto <produtoId> é obrigatório.'),
    ).join('\n');
    expect(texto).toContain('--produto <produtoId> é obrigatório.');
    expect(texto).toContain('publicar:anuncio');
    expect(texto).not.toContain('importar:pedido');
  });
});
