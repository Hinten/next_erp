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

import { ESTADO_ANUNCIO_SHOPEE, fotoSchema } from '@delfrance/schemas';

import type { PlanoKit } from '../kits/planoKit';
import type { ContextoKitPreparado } from '../kits/prepararKit';
import type { EnsaioDeKit } from '../kits/publicarKit';
import {
  MENSAGEM_KIT_INCERTO,
  comandoDeRetomada,
  type ResultadoPublicacaoKit,
} from '../kits/resultadoKit';
import type { AtributosProjetados } from '../taxonomia/dto';
import { naoDocId } from './corpoPublicacao';
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
  MSG_CLI_RECRIAR_E_CONVERTER,
  MSG_CLI_RECRIAR_SEM_LINK,
  MSG_STATUS_INVALIDO,
  NOTA_SANDBOX_SG_KIT,
  USO_PUBLICAR_ANUNCIO,
  descreverErroPublicacao,
  lerArgsPublicar,
  renderizarEnsaioDeKit,
  renderizarPlano,
  renderizarResultado,
  renderizarResultadoKit,
  resumoDaPublicacao,
  resumoDoEnsaioDeKit,
  resumoDoResultado,
  resumoDoResultadoKit,
  type ContextoDoEnsaio,
  type OpcoesDoKitCli,
} from './publicarAnuncioCli';
import { lerArgsReverificar } from './reverificarAnuncioCli';
import type { ResultadoPublicacao } from './publicarAnuncio';
import type { ResultadoTabelaDeMedidasShopee } from './tabelaMedidasPublicacao';
import { MOTIVO_TAX_INFO_OMITIDO } from './taxInfoPublicacao';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, item or seller.  */
/* -------------------------------------------------------------------------- */

/** The composition root, read as TEXT — the only way to see what it calls where. */
const FONTE_SCRIPT = readFileSync(
  new URL('../../../scripts/publicar-anuncio.ts', import.meta.url),
  'utf8',
);

/**
 * The CLI half read as TEXT. A behavioural test cannot see a SECOND copy of a
 * rule — only that whichever copy ran gave the right answer — and a second copy
 * of the doc-id rule is exactly what this file used to carry.
 */
const FONTE_CLI = readFileSync(new URL('./publicarAnuncioCli.ts', import.meta.url), 'utf8');

const INTEGRACAO_ID = 'int-1';
const PRODUTO_ID = 'prod-pai-1';
const LINK_DOC_ID = 'link-1';
const ITEM_ID = 2500139861;
const MODEL_ID = 2000458802;
const CATEGORIA_ID = 100017;
/** Shopee's own doc-sample template id — never a real shop's. */
const MODELO_TABELA = 700024641;

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
    size_chart_info: { size_chart_id: MODELO_TABELA },
    description_type: 'normal',
  };
}

/** The item mapper's size-chart decision for {@link corpoCriar}: a template matched. */
function decisaoDaTabela(
  over: Partial<ResultadoTabelaDeMedidasShopee> = {},
): ResultadoTabelaDeMedidasShopee {
  return {
    fonte: { tipo: 'modelo', sizeChartId: MODELO_TABELA },
    sizeChartId: MODELO_TABELA,
    motivo: null,
    tabMediId: 'tab-1',
    entradasNestaConta: 3,
    ilegiveis: 1,
    obrigatoria: true,
    suportaModelo: true,
    suportaFoto: null,
    fotoOmitida: null,
    avisoObrigatoria: false,
    ...over,
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
    item: { criar, atualizar: null, problemas: [], tabelaDeMedidas: decisaoDaTabela() },
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
      tabelaDeMedidas: null,
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
    recusaTabelaDeMedidas: null,
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
    tabelaDeMedidas: {
      sizeChartId: MODELO_TABELA,
      fonte: 'modelo',
      motivo: null,
      fotoOmitida: null,
      avisoObrigatoria: false,
      lidaDeVolta: MODELO_TABELA,
      fotoLidaDeVolta: true,
    },
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
        principal: null,
        recriar: false,
        converterEmKit: false,
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
      '--principal=comp-a-filho',
      '--recriar',
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
        principal: 'comp-a-filho',
        recriar: true,
        converterEmKit: false,
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

  it('⚠️ o PAR relativo: "." e ".." são recusados — a cópia local os aceitava', () => {
    // A cópia local que este módulo carregava recusava `''` e a barra e mais nada,
    // então `--produto ..` passava pela validação e chegava em
    // `produtos/../prodshopee`. O `.doc('..')` do admin NÃO lança localmente — ele
    // resolve —, e o operador recebia um INVALID_ARGUMENT do servidor no lugar
    // desta frase. Uma regra só, a de `./corpoPublicacao`.
    expect(naoDocId('.')).toBe(true);
    expect(naoDocId('..')).toBe(true);
    expect(() => lerArgsPublicar(['--integracao', INTEGRACAO_ID, '--produto', '..'])).toThrow(
      /não é um id de documento/,
    );
    expect(() => lerArgsPublicar(['--integracao', '.', '--produto', PRODUTO_ID])).toThrow(
      /não é um id de documento/,
    );
    expect(() =>
      lerArgsPublicar(['--integracao', INTEGRACAO_ID, '--produto', PRODUTO_ID, '--link', '..']),
    ).toThrow(ArgumentoInvalidoError);
  });

  it('⚠️ NEAR-MISS: um id com pontos NO MEIO continua aceito', () => {
    // A regra são os dois nomes relativos INTEIROS, nunca "contém ponto": um id de
    // documento com ponto é legítimo, e recusá-lo seria a mesma falha ao contrário.
    for (const aceito of ['prod.pai.1', '.oculto', 'v1.2', '...']) {
      const cmd = lerArgsPublicar(['--integracao', INTEGRACAO_ID, '--produto', aceito]);
      expect(cmd.kind === 'publicar' && cmd.args.produtoId).toBe(aceito);
    }
  });

  it('⛔ a regra de doc id é IMPORTADA, e este módulo não declara uma segunda', () => {
    // O defeito não foi a predicate errada, foi HAVER DUAS: as cópias derivam para
    // o plausível e continuam verdes. Só o texto do módulo vê a segunda nascer.
    expect(FONTE_CLI).toContain("import { naoDocId } from './corpoPublicacao'");
    expect(FONTE_CLI).not.toMatch(/function\s+\w*DocId\w*\s*\(/);
    expect(FONTE_CLI).not.toContain('naoEhDocId');
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

describe('lerArgsPublicar — as três opções de kit nativo (passo 19)', () => {
  const BASE = ['--integracao', INTEGRACAO_ID, '--produto', PRODUTO_ID] as const;
  const args = (...extra: string[]) => {
    const cmd = lerArgsPublicar([...BASE, ...extra]);
    if (cmd.kind !== 'publicar') throw new Error('esperava publicar');
    return cmd.args;
  };

  it('--principal é um id de documento, pela MESMA regra de --produto', () => {
    expect(args('--principal', 'comp-a-filho').principal).toBe('comp-a-filho');
    expect(args('--principal=comp-a-filho').principal).toBe('comp-a-filho');
    // ⚠️ NEAR-MISS: um caminho ou um nome relativo NUNCA é um produto componente.
    for (const recusado of ['produtos/comp-a', '..', '']) {
      expect(() => args('--principal', recusado)).toThrow(ArgumentoInvalidoError);
    }
    expect(() => args('--principal')).toThrow(/--principal exige um valor/);
  });

  it('⚠️ PAR (M175, a metade da CLI): --recriar COM --link passa; SEM --link é o erro de uso — a recriação sempre nomeia o kit antigo', () => {
    expect(args('--link', LINK_DOC_ID, '--recriar')).toMatchObject({
      linkDocId: LINK_DOC_ID,
      recriar: true,
      converterEmKit: false,
    });
    // A ordem das flags não importa: a checagem é depois da leitura inteira.
    expect(args('--recriar', '--link', LINK_DOC_ID).recriar).toBe(true);
    expect(() => args('--recriar')).toThrow(ArgumentoInvalidoError);
    expect(() => args('--recriar')).toThrow(MSG_CLI_RECRIAR_SEM_LINK);
    expect(() => args('--recriar', '--principal', 'comp-a-filho', '--live')).toThrow(
      MSG_CLI_RECRIAR_SEM_LINK,
    );
  });

  it('⚠️ PAR: --converter-em-kit sozinho ou com --link passa; junto com --recriar é o erro de uso — UMA ação de kit por execução', () => {
    expect(args('--converter-em-kit')).toMatchObject({
      linkDocId: null,
      recriar: false,
      converterEmKit: true,
    });
    expect(args('--converter-em-kit', '--link', LINK_DOC_ID).linkDocId).toBe(LINK_DOC_ID);
    expect(() => args('--converter-em-kit', '--recriar', '--link', LINK_DOC_ID)).toThrow(
      MSG_CLI_RECRIAR_E_CONVERTER,
    );
    // ⚠️ As duas recusas acontecem ANTES de qualquer leitura: nenhuma delas é a
    // 400 da rota — é a mesma regra, falada com as flags DESTE comando.
    expect(MSG_CLI_RECRIAR_SEM_LINK).toContain('--link');
    expect(MSG_CLI_RECRIAR_E_CONVERTER).toContain('--converter-em-kit');
  });

  it('a ajuda ainda vence as recusas de kit, e a ajuda documenta as três opções', () => {
    expect(lerArgsPublicar(['--recriar', '--converter-em-kit', '--help'])).toEqual({
      kind: 'ajuda',
    });
    for (const flag of ['--principal <id>', '--recriar', '--converter-em-kit']) {
      expect(USO_PUBLICAR_ANUNCIO).toContain(flag);
    }
    // R-w: o aviso de nunca rodar dois comandos de kit ao mesmo tempo.
    expect(USO_PUBLICAR_ANUNCIO).toContain('NUNCA rode um comando de kit');
    // ⚠️ A frase velha ("KIT é recusado antes de existir plano") morreu com o
    // despachante: um kit nativo agora é publicado, não recusado.
    expect(USO_PUBLICAR_ANUNCIO).not.toContain('FILHO ou KIT é recusado');
  });

  it('(OP-9 / H4) a ajuda diz que --status UNLIST VALE na criação de um kit nativo e só é ignorado numa republicação', () => {
    expect(USO_PUBLICAR_ANUNCIO).toContain('vale na CRIAÇÃO (add_kit_item com «unlisted»)');
    expect(USO_PUBLICAR_ANUNCIO).toContain('e é ignorado numa republicação.');
    // ⛔ A frase velha mentia: desde o OP-9 a criação MANDA `unlisted: true`.
    expect(USO_PUBLICAR_ANUNCIO).not.toContain('o add_kit_item vai sem «unlisted»');
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
        'tabelaDeMedidas',
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
        tabelaDeMedidas: decisaoDaTabela(),
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
/*  4b · size_chart_info — passo 18 (#1526)                                    */
/* ========================================================================== */

describe('size_chart_info (passo 18)', () => {
  const SENTINELA_IMAGE_ID_TABELA = 'SENTINELA-IMAGE-ID-DA-FOTO-DA-TABELA';
  const FOTO_DA_TABELA = fotoSchema.parse({ arquivoOuterRef: 'arquivos/arq-tabela-1' });

  function secao(p: PlanoPublicacao): string {
    const texto = renderizarPlano(p, contexto()).join('\n');
    return texto.slice(texto.indexOf('### size_chart_info'), texto.indexOf('### logistic_info'));
  }

  function semTabela(decisao: Partial<ResultadoTabelaDeMedidasShopee>): PlanoPublicacao {
    const { size_chart_info: _fora, ...criar } = corpoCriar();
    return plano({
      item: {
        criar,
        atualizar: null,
        problemas: [],
        tabelaDeMedidas: decisaoDaTabela({
          fonte: { tipo: 'nenhuma' },
          sizeChartId: null,
          motivo: 'categoria-sem-entrada',
          ...decisao,
        }),
      },
    });
  }

  it('o MODELO sai com o id (não é PII) e a contagem de entradas desta conta', () => {
    const s = secao(plano());
    expect(s).toContain(`size_chart_id ${String(MODELO_TABELA)}`);
    expect(s).toContain('tab-1  3 entrada(s) nesta conta · 1 ilegível(is)');
    expect(s).toContain('obrigatória=sim  modelo=sim  foto=—');
    expect(s).not.toContain('⚠️');
    expect(resumoDaPublicacao(plano(), contexto()).tabelaDeMedidas.enviado).toBe('size_chart_id');
  });

  it('⛔ a FOTO sai como "a primeira foto da tabela" — o image_id NUNCA, nem no texto nem no --json', () => {
    const comFoto = plano({
      item: {
        criar: { ...corpoCriar(), size_chart_info: { size_chart: SENTINELA_IMAGE_ID_TABELA } },
        atualizar: null,
        problemas: [],
        tabelaDeMedidas: decisaoDaTabela({
          fonte: { tipo: 'foto', foto: FOTO_DA_TABELA },
          sizeChartId: null,
          motivo: 'conta-sem-entradas',
        }),
      },
    });
    const texto = renderizarPlano(comFoto, contexto()).join('\n');
    const json = JSON.stringify(resumoDaPublicacao(comFoto, contexto()));

    expect(JSON.stringify(comFoto.item.criar)).toContain(SENTINELA_IMAGE_ID_TABELA);
    expect(texto).toContain('size_chart — a PRIMEIRA foto da tabela');
    expect(texto).not.toContain(SENTINELA_IMAGE_ID_TABELA);
    expect(json).not.toContain(SENTINELA_IMAGE_ID_TABELA);
    expect(json).not.toContain('arq-tabela-1');
    expect(resumoDaPublicacao(comFoto, contexto()).tabelaDeMedidas.enviado).toBe('size_chart');
  });

  it('omitido NOMEIA o motivo; obrigatória e nada enviado ⇒ o aviso (S9) — e nada é bloqueado', () => {
    const s = secao(
      semTabela({ fotoOmitida: 'sem-fotos', avisoObrigatoria: true, obrigatoria: true }),
    );
    expect(s).toContain('— omitido (categoria-sem-entrada; foto: sem-fotos)');
    expect(s).toContain('⚠️ a categoria declara tabela OBRIGATÓRIA');
    expect(renderizarPlano(semTabela({ avisoObrigatoria: true }), contexto()).join('\n')).toContain(
      'problemas: NENHUM',
    );
  });

  it('⚠️ NEAR-MISS: obrigatória mas um modelo FOI enviado ⇒ nenhum aviso', () => {
    expect(secao(plano())).not.toContain('OBRIGATÓRIA');
  });

  it('o bloco de limites ausente é dito ausente — nunca "não"', () => {
    const s = secao(semTabela({ obrigatoria: null, suportaModelo: null, suportaFoto: null }));
    expect(s).toContain('size_chart_limit ........ — (bloco ausente)');
  });

  it('a categoria que recusa foto e o modelo enviado contra support_template false ganham cada um a sua linha', () => {
    expect(secao(semTabela({ fotoOmitida: 'categoria-sem-foto', suportaFoto: false }))).toContain(
      'support_image_size_chart=false',
    );
    expect(
      secao(
        plano({
          item: { ...plano().item, tabelaDeMedidas: decisaoDaTabela({ suportaModelo: false }) },
        }),
      ),
    ).toContain('support_template_size_chart=false');
  });

  it('⛔ a foto que não subiu é RECUSA: problemas (1), NADA seria enviado — nunca "publicável"', () => {
    const recusado = plano({
      ...semTabela({ fonte: { tipo: 'foto', foto: FOTO_DA_TABELA } }),
      passos: [{ tipo: 'fotos', enviadas: 0, reutilizadas: 0 }],
      recusaTabelaDeMedidas: {
        campo: 'size_chart_info',
        motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasFotoRecusada,
        mensagem: 'foto da tabela de medidas recusada pela Shopee (envio da foto: upload-recusado)',
      },
    });
    const texto = renderizarPlano(recusado, contexto()).join('\n');

    expect(texto).toContain('enviado ................. NADA');
    expect(texto).toContain('⛔ foto da tabela de medidas recusada');
    expect(texto).toContain('### problemas (1) — NADA seria enviado');
    expect(texto).toContain(MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasFotoRecusada);
    expect(texto).not.toContain('problemas: NENHUM');
  });

  it('o --live diz o que foi enviado e o que a releitura ECOOU — DIVERGE quando não bate', () => {
    const linha = (t: Partial<ResultadoPublicacao['tabelaDeMedidas']>): string =>
      renderizarResultado(resultado({ tabelaDeMedidas: { ...resultado().tabelaDeMedidas, ...t } }))
        .join('\n')
        .split('\n')
        .find((l) => l.includes('size_chart_info')) ?? '';

    expect(linha({})).toBe(
      `  size_chart_info ......... enviado ${String(MODELO_TABELA)} · lido de volta ${String(MODELO_TABELA)}`,
    );
    // ⚠️ NEAR-MISS: um 0 de zero-fill é DADO — e diverge do que foi enviado.
    expect(linha({ lidaDeVolta: 0 })).toContain('lido de volta 0  DIVERGE');
    expect(linha({ lidaDeVolta: MODELO_TABELA + 1 })).toContain('DIVERGE');
    // Releitura degradada: "—", nunca uma divergência inventada.
    expect(linha({ lidaDeVolta: null })).toContain('lido de volta —');
    expect(linha({ lidaDeVolta: null })).not.toContain('DIVERGE');
    expect(
      linha({ fonte: 'foto', sizeChartId: null, motivo: 'conta-sem-entradas', lidaDeVolta: null }),
    ).toContain('enviada a primeira foto da tabela · foto lida de volta: sim');
    expect(
      linha({
        fonte: 'nenhuma',
        sizeChartId: null,
        motivo: 'produto-sem-tabela',
        lidaDeVolta: null,
      }),
    ).toContain('omitido (produto-sem-tabela)');
  });

  it('o resumo do --live leva a tabela por NOME — sete campos, nenhum a mais', () => {
    const res = resultado({
      // Um campo que a onda seguinte poderia acrescentar — o resumo não o copia.
      tabelaDeMedidas: {
        ...resultado().tabelaDeMedidas,
        inventado: 'NÃO PODE VAZAR',
      } as unknown as ResultadoPublicacao['tabelaDeMedidas'],
    });
    const resumo = resumoDoResultado(res);
    expect(Object.keys(resumo.tabelaDeMedidas).sort()).toEqual([
      'avisoObrigatoria',
      'fonte',
      'fotoLidaDeVolta',
      'fotoOmitida',
      'lidaDeVolta',
      'motivo',
      'sizeChartId',
    ]);
    expect(JSON.stringify(resumo)).not.toContain('NÃO PODE VAZAR');
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
  /** The dry-run branch, from its guard to the live marker. */
  const RAMO_DRY_RUN = FONTE_SCRIPT.slice(
    FONTE_SCRIPT.indexOf('if (!live) {'),
    FONTE_SCRIPT.indexOf('/* ---------------------------------- live'),
  );
  /** The live branch, from its marker to the end of `main`. */
  const RAMO_LIVE = FONTE_SCRIPT.slice(
    FONTE_SCRIPT.indexOf('/* ---------------------------------- live'),
    FONTE_SCRIPT.indexOf('await main()'),
  );

  it('⛔ só chama publicarShopee DEPOIS do ramo do dry-run', () => {
    // O mutante é mover a chamada para o caminho padrão: uma rehearsal passaria
    // a criar anúncio (ou KIT) de verdade sem ninguém pedir `--live`.
    const guarda = FONTE_SCRIPT.indexOf('if (!live) {');
    const chamada = FONTE_SCRIPT.indexOf('await publicarShopee(');
    expect(guarda).toBeGreaterThan(0);
    expect(chamada).toBeGreaterThan(guarda);
    // …e ela acontece UMA vez só, no ramo live.
    expect(FONTE_SCRIPT.match(/await publicarShopee\(/g)).toHaveLength(1);
    expect(RAMO_LIVE).toContain('await publicarShopee(');
  });

  it('⛔ (L10-R1, a metade da CLI do M186) o dry-run e o --live passam pelo MESMO despachante — nenhum dos dois escolhe anúncio por conta própria', () => {
    // O dry-run pergunta ao despachante (`ensaiarPublicacaoShopee`), e o --live
    // também (`publicarShopee`). Passar o `--link` CRU a `prepararPublicacao`
    // re-resolveria lexicalmente sobre TODOS os vínculos — um kit removido ou um
    // anúncio substituído inclusive — e ensaiaria OUTRO anúncio do que o --live
    // publica.
    expect(RAMO_DRY_RUN).toContain('await ensaiarPublicacaoShopee(');
    expect(FONTE_SCRIPT.match(/ensaiarPublicacaoShopee\(/g)).toHaveLength(1);
    for (const atalho of [
      'prepararPublicacao(',
      'publicarAnuncioShopee(',
      'publicarKitShopee(',
      'ensaiarKitShopee(',
      'prepararKit(',
    ]) {
      expect(FONTE_SCRIPT).not.toContain(atalho);
    }
  });

  it('o dry-run planeja o item com o contexto que o despachante preparou, e nenhum escritor', () => {
    expect(RAMO_DRY_RUN).toContain('planejarPublicacao(');
    expect(RAMO_DRY_RUN).toContain('await resolverFotosDaPublicacao(');
    expect(RAMO_DRY_RUN).toContain('renderizarEnsaioDeKit(');
    expect(FONTE_SCRIPT).not.toContain('aplicarPublicacao(');
    expect(RAMO_DRY_RUN).not.toContain('publicarShopee(');
  });

  it('o --live liga o `increment` do aviso de composição, como a rota', () => {
    expect(FONTE_SCRIPT).toContain('increment: (by: number) => FieldValue.increment(by)');
    expect(FONTE_SCRIPT).toContain("await import('firebase-admin/firestore')");
  });

  it('⚠️ um kit INCERTO no --live sai com 1 — e é o ÚNICO exitCode do ramo live além do 404', () => {
    expect(RAMO_LIVE).toContain("res.resultado.desfecho === 'incerto'");
    expect(RAMO_LIVE.match(/process\.exitCode = 1/g)).toHaveLength(2);
    expect(RAMO_LIVE).toContain('renderizarResultadoKit(');
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

  it('(R3-02) o fecho de um bloqueio NUNCA promete que nenhum vínculo foi gravado no --live: um kit nativo grava antes de recusar', () => {
    // The `kit-atualizar` applier's deleted-target branch: the link is written
    // `removido` and THEN this refusal is thrown — the same class, the same
    // motivo a dispatcher refusal carries, so only the closing can be honest.
    const linhas = descreverErroPublicacao(
      new ShopeePublishBlockedError({
        produtoId: KIT_PRODUTO,
        itemId: KIT_ITEM,
        problemas: [
          {
            campo: null,
            motivo: MOTIVO_PUBLICACAO_BLOQUEADA.listagemRemovida,
            mensagem: 'mecanismo',
          },
        ],
      }),
    );
    const texto = linhas.join('\n');
    // ⛔ The old unconditional promise is gone…
    expect(texto).not.toContain('Nada foi enviado à Shopee e nenhum vínculo foi gravado');
    // …the dry run keeps its guarantee, on its own line…
    expect(linhas.at(-2)).toBe(
      '  No --dry-run a recusa é anterior a qualquer escrita: nada foi enviado à Shopee e ' +
        'nenhum vínculo foi gravado.',
    );
    // …and `--live` says what a kit arm may already have written.
    expect(linhas.at(-1)).toBe(
      '  ⚠️ No --live ela pode vir DEPOIS de escritas: um kit nativo grava antes no ERP o que ' +
        'leu da Shopee (o vínculo, as variações do kit, o aviso de composição), e a atualização ' +
        'de um anúncio comum pode já ter enviado o update_item. Releia com --dry-run antes de ' +
        'repetir.',
    );
    // ⛔ QUASE-PAR: a REJEIÇÃO da Shopee não ganha essas linhas — ela já tem a sua.
    const rejeitada = descreverErroPublicacao(
      new ShopeePublishRejectedError({
        etapa: ETAPA_PUBLICACAO.updateKitItem,
        shopeeCode: 'product.error_param',
        produtoId: KIT_PRODUTO,
        itemId: KIT_ITEM,
        problemas: [],
      }),
    ).join('\n');
    expect(rejeitada).not.toContain('No --dry-run a recusa');
    expect(rejeitada).toContain('Escritas ANTERIORES podem ter acontecido');
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
    expect(linhas[1]).toBe(
      'Publicação recusada pela Shopee em init_tier_variation (product.error_param)',
    );
  });

  it('a foto da tabela (passo 18): sem código não há "()" — e a que a Shopee NUNCA viu não é "recusada pela Shopee"', () => {
    const recusa = (recusadaPelaShopee: boolean) =>
      descreverErroPublicacao(
        new ShopeePublishRejectedError({
          etapa: ETAPA_PUBLICACAO.fotos,
          shopeeCode: '',
          produtoId: PRODUTO_ID,
          itemId: null,
          problemas: [
            {
              campo: 'size_chart_info',
              motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasFotoRecusada,
              mensagem: 'mecanismo',
            },
          ],
          recusadaPelaShopee,
        }),
      );

    // PAR: a Shopee recusou o upload — a linha diz isso, sem parênteses vazios.
    expect(recusa(true)[1]).toBe('Publicação recusada pela Shopee em fotos');
    // QUASE-PAR: a foto nunca chegou à Shopee — ninguém a culpa.
    expect(recusa(false)[1]).toBe('Publicação interrompida em fotos');
    for (const linhas of [recusa(true), recusa(false)]) {
      expect(linhas.join('\n')).not.toContain('()');
    }
    expect(recusa(false).join('\n')).not.toContain('pela Shopee');
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

  it('(passo 19) um add_kit_item recusado de vez (`nao-criado`) diz que a Shopee NÃO criou o kit — nunca "o add_item"', () => {
    const linhas = descreverErroPublicacao(
      new ShopeePublishRejectedError({
        etapa: ETAPA_PUBLICACAO.addKitItem,
        shopeeCode: 'product.error_busi_cannot_edit_vsku',
        produtoId: KIT_PRODUTO,
        itemId: null,
        problemas: [
          {
            campo: null,
            motivo: MOTIVO_PROBLEMA_PUBLICACAO.kitBloqueadoPelaShopee,
            mensagem: 'mecanismo',
          },
        ],
      }),
    );
    const texto = linhas.join('\n');
    expect(texto).toContain('o add_kit_item foi recusado: a Shopee não criou o kit');
    expect(texto).not.toContain('o add_item foi recusado');
    // ⚠️ QUASE-PAR: a etapa de step 11 continua dizendo o que dizia.
    const doItem = descreverErroPublicacao(
      new ShopeePublishRejectedError({
        etapa: ETAPA_PUBLICACAO.addItem,
        shopeeCode: 'product.error_param',
        produtoId: PRODUTO_ID,
        itemId: null,
        problemas: [],
      }),
    ).join('\n');
    expect(doItem).toContain('nenhum (o add_item foi recusado)');
  });
});

/* ========================================================================== */
/*  8 · o kit nativo (passo 19) — o ensaio e o resultado, por NOME             */
/* ========================================================================== */

const KIT_PRODUTO = 'kit-k';
const KIT_ITEM = 2500139870;
const COMP_A_ITEM = 2500139871;
const COMP_A_MODELO = 2000458821;
const COMP_B_ITEM = 2500139872;
const VINCULO_KIT = 'vinculo-kit-1';
const VINCULO_ANTIGO = 'vinculo-kit-antigo';
const VINCULO_COMUM = 'link-comum';
const SENTINELA_IMAGEM_DE_OPCAO = 'SENTINELA-IMAGEM-DE-OPCAO-DO-KIT';

const OPCOES_KIT: OpcoesDoKitCli = { integracaoId: INTEGRACAO_ID, projectId: null, sandbox: false };

/** Azul = A (o principal) + B (sem variação); Verde = 2 × A. */
const LINHAS_AZUL = [
  {
    component_item_id: COMP_A_ITEM,
    component_model_id: COMP_A_MODELO,
    quantity: 1,
    main_component: true as const,
  },
  { component_item_id: COMP_B_ITEM, quantity: 1 },
];
const LINHAS_VERDE = [
  { component_item_id: COMP_A_ITEM, component_model_id: COMP_A_MODELO, quantity: 2 },
];

/**
 * A kit dry run as `ensaiarKitShopee` answers it — every sentinel where the
 * value it stands for REALLY lives, so each absence below is not vacuous.
 */
function ensaioDeKit(
  over: {
    readonly contexto?: Partial<ContextoKitPreparado>;
    readonly plano?: Partial<PlanoKit>;
  } = {},
): EnsaioDeKit {
  const contexto: ContextoKitPreparado = {
    arma: { arma: 'kit-criar' },
    integracaoId: INTEGRACAO_ID,
    produto: { id: KIT_PRODUTO, sku: 'KIT-1', raw: { nome: 'Kit camiseta e boné' } },
    filhos: [
      {
        produtoId: 'kit-k-azul',
        sku: 'KIT-1-AZ',
        ordem: 1,
        componentesKit: { 'comp-a-filho': { quantidade: 1 }, 'comp-b-membro': { quantidade: 1 } },
        preco: 99.9,
        variante: 'Azul',
      },
      {
        produtoId: 'kit-k-verde',
        sku: 'KIT-1-VD',
        ordem: 2,
        componentesKit: { 'comp-a-filho': { quantidade: 2 } },
        preco: 99.9,
        variante: 'Verde',
      },
    ],
    familiaDeUm: false,
    grupo: { id: 'grupo-cor', nome: 'Cor' },
    gruposDistintos: 1,
    descricao: SENTINELA_DESCRICAO,
    resolucao: new Map(),
    temModelos: new Map(),
    categoriaPorProduto: new Map(),
    principal: { itemId: COMP_A_ITEM, modelId: COMP_A_MODELO },
    principalPedido: { itemId: COMP_A_ITEM, modelId: COMP_A_MODELO },
    limites: { estado: 'indisponivel' },
    canais: [],
    vinculos: [],
    alvo: null,
    vivo: null,
    linhasDoAnuncio: [],
    linhasDaConta: [],
    busca: { completo: true, achados: [], paginas: 1, chamadas: 2 },
    nossosVivos: new Map(),
    fotos: {
      item: {
        imageIds: [SENTINELA_IMAGE_ID],
        reutilizadas: 0,
        enviadas: 1,
        falhas: [
          {
            arquivoId: 'arq-3',
            motivo: MOTIVO_FOTO_PUBLICACAO.http,
            mensagem: `falhou ao baixar ${SENTINELA_URL_ARQUIVO}`,
          },
        ],
        consideradas: 2,
        descartadasPeloLimite: 0,
      },
      imagensDeOpcao: null,
      tabelaDeMedidas: null,
      resumo: {
        consideradas: 2,
        reutilizadas: 0,
        enviadas: 1,
        falhas: 1,
        descartadasPeloLimite: 0,
      },
    },
    ...over.contexto,
  };
  const plano: PlanoKit = {
    problemas: [],
    avisos: [
      {
        codigo: 'componente-nao-limita-estoque',
        produtoId: 'comp-b-membro',
        mensagem: 'o componente comp-b-membro está com «Limita estoque» desligado',
      },
    ],
    kitNovo: { acao: 'criar' },
    corpo: {
      item_setting: {
        item_name: 'Kit camiseta e boné',
        images: { image_id_list: [SENTINELA_IMAGE_ID] },
        description_type: 'normal',
        description: SENTINELA_DESCRICAO,
        logistic_info: [{ logistic_id: 90_003, enabled: true }],
        weight: 0.8,
        dimension: { package_height: 10, package_length: 30, package_width: 20 },
        item_sku: 'KIT-1',
        tier_variation_list: [
          {
            name: 'Cor',
            // Nada do passo 19 envia imagem de opção — o sentinela prova que,
            // se um corpo futuro enviar, ela não tem campo por onde viajar.
            option_list: [
              { option: 'Azul', image: { image_id: SENTINELA_IMAGEM_DE_OPCAO } },
              { option: 'Verde', image: { image_id: SENTINELA_IMAGEM_DE_OPCAO } },
            ],
          },
        ],
        model_list: [
          {
            tier_index: [0],
            original_price: 99.9,
            model_sku: 'KIT-1-AZ',
            component_list: LINHAS_AZUL,
          },
          {
            tier_index: [1],
            original_price: 99.9,
            model_sku: 'KIT-1-VD',
            component_list: LINHAS_VERDE,
          },
        ],
      },
      sync_setting: { auto_sync_dts: true },
    },
    modelos: [
      { filhoId: 'kit-k-azul', tierIndex: 0, linhas: LINHAS_AZUL, projecaoCompleta: true },
      { filhoId: 'kit-k-verde', tierIndex: 1, linhas: LINHAS_VERDE, projecaoCompleta: true },
    ],
    principal: { itemId: COMP_A_ITEM, modelId: COMP_A_MODELO },
    sku: 'KIT-1',
    ...over.plano,
  };
  return { contexto, plano };
}

/** A kit `--live` result, `criado` by default. */
function resultadoKit(over: Partial<ResultadoPublicacaoKit> = {}): ResultadoPublicacaoKit {
  return {
    arma: 'kit-criar',
    desfecho: 'criado',
    produtoId: KIT_PRODUTO,
    itemId: KIT_ITEM,
    linkDocId: VINCULO_KIT,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    itemStatus: 'NORMAL',
    kitNativo: true,
    modelos: { vinculados: 2, anexados: 0, semFilho: 0 },
    antecessor: null,
    avisos: [],
    avisosResolvidos: 0,
    chamadasShopee: 9,
    recusa: null,
    comando: null,
    ...over,
  };
}

/** The `incerto` of a given arm, its `comando` built by the REAL `comandoDeRetomada`. */
function resultadoIncerto(
  arma: ResultadoPublicacaoKit['arma'],
  linkDocId: string | null,
  principal: string | null,
): ResultadoPublicacaoKit {
  return resultadoKit({
    arma,
    desfecho: 'incerto',
    itemId: null,
    linkDocId: null,
    estadoAnuncio: null,
    itemStatus: null,
    kitNativo: null,
    modelos: { vinculados: 0, anexados: 0, semFilho: 0 },
    recusa: {
      codigo: 'product.error_busi',
      fraseShopee: 'Too many connections',
      motivo: MOTIVO_PROBLEMA_PUBLICACAO.instabilidadeShopee,
    },
    comando: comandoDeRetomada(arma, {
      integracaoId: INTEGRACAO_ID,
      produtoId: KIT_PRODUTO,
      linkDocId,
      principal,
    }),
  });
}

/** `pnpm --filter @delfrance/shopee-app <script> …flags` ⇒ the flags, as argv. */
function argvDoComando(comando: string, script: string): string[] {
  const prefixo = `pnpm --filter @delfrance/shopee-app ${script} `;
  expect(comando.startsWith(prefixo)).toBe(true);
  return comando.slice(prefixo.length).split(' ');
}

describe('o ensaio de um kit nativo (passo 19) — a lista permitida', () => {
  const e = ensaioDeKit();
  const resumo = resumoDoEnsaioDeKit(e, OPCOES_KIT);
  const texto = renderizarEnsaioDeKit(e, OPCOES_KIT).join('\n');
  const comoJson = JSON.stringify(resumo);

  it.each([
    ['a arma', 'arma kit-criar'],
    ['o item_sku', 'KIT-1'],
    ['as variações no eixo', '2 no eixo "Cor"'],
    ['o principal', `item ${String(COMP_A_ITEM)} modelo ${String(COMP_A_MODELO)}`],
    [
      'a busca de SKU com páginas e chamadas',
      '1 página(s), 2 chamada(s) — nenhum kit com este SKU',
    ],
    ['a decisão do kit novo', 'CRIAR (add_kit_item)'],
    ['o título (de propósito)', '"Kit camiseta e boné"'],
    [
      'a descrição como CONTAGEM',
      `«REDIGIDA — ${String(SENTINELA_DESCRICAO.length)} caractere(s)»`,
    ],
    ['as opções do tier', '"Cor": "Azul", "Verde"'],
    [
      'os componentes com o principal marcado',
      `${String(COMP_A_ITEM)}/${String(COMP_A_MODELO)} ×1 (principal)`,
    ],
    ['o componente sem variação SEM modelo', `${String(COMP_B_ITEM)} ×1`],
    ['o aviso com o código', 'componente-nao-limita-estoque'],
    [
      'a falha de foto como arquivo + motivo',
      `falha: arquivo arq-3 — ${MOTIVO_FOTO_PUBLICACAO.http}`,
    ],
    ['o veredito', 'problemas: NENHUM — este kit é publicável'],
  ])('imprime %s', (_o, trecho) => {
    expect(texto).toContain(trecho);
  });

  it.each([
    ['a description', SENTINELA_DESCRICAO],
    ['um image_id', SENTINELA_IMAGE_ID],
    ['a imagem de uma opção do tier', SENTINELA_IMAGEM_DE_OPCAO],
    ['a URL de um arquivo (só existe na mensagem da falha)', SENTINELA_URL_ARQUIVO],
  ])('⛔ NÃO carrega %s — nem no texto, nem no --json', (_o, sentinela) => {
    expect(texto).not.toContain(sentinela);
    expect(comoJson).not.toContain(sentinela);
  });

  it('…e cada sentinela REALMENTE está no ensaio — nenhuma ausência é vazia', () => {
    const cru = JSON.stringify(e.plano.corpo) + JSON.stringify(e.contexto.fotos);
    for (const s of [
      SENTINELA_DESCRICAO,
      SENTINELA_IMAGE_ID,
      SENTINELA_IMAGEM_DE_OPCAO,
      SENTINELA_URL_ARQUIVO,
    ]) {
      expect(cru).toContain(s);
    }
  });

  it('o resumo tem um conjunto de campos FIXO — um campo novo tem de ser olhado', () => {
    expect(Object.keys(resumo).sort()).toEqual(
      [
        'alvoLinkDocId',
        'arma',
        'avisos',
        'busca',
        'conteudo',
        'corpo',
        'eixo',
        'familiaDeUm',
        'fotos',
        'kitNovo',
        'limitesKit',
        'modelos',
        'principal',
        'principalPedido',
        'problemas',
        'produtoId',
        'sandbox',
        'sku',
        'statusDoAlvo',
        'variacoes',
      ].sort(),
    );
    expect(Object.keys(resumo.corpo ?? {}).sort()).toEqual(
      [
        'canais',
        'descricaoChars',
        'dimension',
        'imagens',
        'itemName',
        'itemNameChars',
        'itemSku',
        'modelos',
        'tier',
        'weight',
      ].sort(),
    );
  });

  it('⚠️ a nota do sandbox SG aparece SÓ no sandbox (preço em SGD num campo BRL)', () => {
    expect(texto).not.toContain(NOTA_SANDBOX_SG_KIT);
    expect(renderizarEnsaioDeKit(e, { sandbox: true }).join('\n')).toContain(NOTA_SANDBOX_SG_KIT);
  });

  it('um plano RECUSADO diz que NADA seria enviado e lista cada problema', () => {
    const recusado = ensaioDeKit({
      plano: {
        corpo: null,
        kitNovo: { acao: 'recusar', problemas: [] },
        problemas: [
          {
            campo: 'principal',
            motivo: MOTIVO_PUBLICACAO_BLOQUEADA.principalObrigatorio,
            mensagem: 'o kit tem componentes de mais de um anúncio da Shopee',
          },
        ],
      },
    });
    const linhas = renderizarEnsaioDeKit(recusado, OPCOES_KIT).join('\n');
    expect(linhas).toContain('### problemas (1) — NADA seria enviado');
    expect(linhas).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.principalObrigatorio);
    expect(linhas).toContain('RECUSADO (veja os problemas)');
    expect(linhas).not.toContain('### add_kit_item');
    // Sem corpo, os modelos PLANEJADOS ainda aparecem — o operador vê a receita.
    expect(linhas).toContain('### modelos planejados (2)');
  });

  it('⛔ QUASE-PAR — kit-atualizar: a busca NÃO roda (L10(4)), o conteúdo do update_kit_item aparece, e foto pulada é "não resolvidas", nunca "sem foto"', () => {
    const atualizar = ensaioDeKit({
      contexto: {
        arma: { arma: 'kit-atualizar', linkDocId: VINCULO_KIT },
        alvo: { linkDocId: VINCULO_KIT, raw: {} },
        vivo: { status: 'NORMAL', kit: null, criadoEm: null },
        busca: null,
        fotos: null,
      },
      plano: {
        kitNovo: null,
        corpo: null,
        conteudo: {
          itemName: 'Kit camiseta e boné',
          description: SENTINELA_DESCRICAO,
          imageIds: null,
          logisticInfo: [{ logistic_id: 90_003, enabled: true }],
          weight: 0.8,
          dimension: null,
        },
      },
    });
    const resumoAtualizar = resumoDoEnsaioDeKit(atualizar, OPCOES_KIT);
    const linhas = renderizarEnsaioDeKit(atualizar, OPCOES_KIT).join('\n');
    expect(resumoAtualizar.busca).toBeNull();
    expect(linhas).toContain('busca de SKU duplicado .. não roda');
    expect(linhas).toContain(`vínculo alvo ............ ${VINCULO_KIT}   item_status vivo=NORMAL`);
    expect(linhas).toContain('### update_kit_item');
    expect(linhas).toContain('— (fotos não resolvidas)');
    expect(linhas).toContain('não resolvidas — nada seria enviado');
    expect(linhas).not.toContain('kit novo ................');
    expect(JSON.stringify(resumoAtualizar)).not.toContain(SENTINELA_DESCRICAO);
  });

  it('uma RETOMADA (completar) diz qual kit já vinculado ela completa — e que nada é criado', () => {
    const retomada = ensaioDeKit({
      contexto: { arma: { arma: 'kit-recriar', linkDocId: VINCULO_ANTIGO } },
      plano: {
        corpo: null,
        kitNovo: { acao: 'completar', linkDocId: VINCULO_KIT, itemId: KIT_ITEM },
      },
    });
    expect(renderizarEnsaioDeKit(retomada, OPCOES_KIT).join('\n')).toContain(
      `COMPLETAR o kit ${String(KIT_ITEM)} já vinculado (vínculo ${VINCULO_KIT}) — nada é criado`,
    );
  });
});

describe('o resultado de um kit nativo no --live (passo 19)', () => {
  it('criado: arma, desfecho, item, vínculo e a leitura de volta — sem bloco de incerteza e sem reverificar', () => {
    const r = resumoDoResultadoKit(resultadoKit(), OPCOES_KIT);
    const texto = renderizarResultadoKit(resultadoKit(), OPCOES_KIT).join('\n');
    expect(texto).toContain('arma kit-criar, desfecho criado');
    expect(texto).toContain(`${String(KIT_ITEM)}   vínculo=${VINCULO_KIT}`);
    expect(texto).toContain('kitNativo=sim');
    expect(r.mensagemIncerto).toBeNull();
    expect(r.comandoDeRetomada).toBeNull();
    expect(r.comandoReverificar).toBeNull();
    expect(texto).not.toContain('INCERTO');
  });

  it('o resumo do --live tem um conjunto de campos FIXO', () => {
    expect(Object.keys(resumoDoResultadoKit(resultadoKit(), OPCOES_KIT)).sort()).toEqual(
      [
        'antecessor',
        'arma',
        'avisos',
        'avisosResolvidos',
        'chamadasShopee',
        'comandoDeRetomada',
        'comandoReverificar',
        'desfecho',
        'estadoAnuncio',
        'itemId',
        'itemStatus',
        'kitNativo',
        'linkDocId',
        'mensagemIncerto',
        'modelos',
        'produtoId',
        'recusa',
        'sandbox',
      ].sort(),
    );
  });

  it('⚠️ INCERTO: a frase do seam VERBATIM, a recusa da Shopee, e o comando EXATO a repetir — com o modo --live', () => {
    const res = resultadoIncerto('kit-recriar', VINCULO_ANTIGO, 'comp-a-filho');
    const r = resumoDoResultadoKit(res, OPCOES_KIT);
    const texto = renderizarResultadoKit(res, OPCOES_KIT).join('\n');

    expect(r.mensagemIncerto).toBe(MENSAGEM_KIT_INCERTO);
    expect(texto).toContain(MENSAGEM_KIT_INCERTO);
    expect(texto).toContain('product.error_busi (instabilidade-shopee) — "Too many connections"');
    expect(r.comandoDeRetomada).toBe(
      `pnpm --filter @delfrance/shopee-app publicar:anuncio --integracao ${INTEGRACAO_ID} ` +
        `--produto ${KIT_PRODUTO} --link ${VINCULO_ANTIGO} --recriar --principal comp-a-filho --live`,
    );
    expect(texto).toContain(r.comandoDeRetomada ?? '§');
    // ⛔ Nunca o separador que o pnpm repassa ao script (pnpm-run-args).
    expect(r.comandoDeRetomada).not.toMatch(/ -- /);
  });

  it.each([
    ['kit-criar', null, null],
    ['kit-criar', null, 'comp-a-filho'],
    ['kit-recriar', VINCULO_ANTIGO, null],
    ['kit-converter', null, 'comp-a-filho'],
    ['kit-converter', VINCULO_COMUM, null],
  ] as const)(
    '⚠️ IDA E VOLTA (S1F-03): o comando impresso para %s (--link %s, --principal %s) é ACEITO por lerArgsPublicar e repete EXATAMENTE as opções de kit, em --live',
    (arma, linkDocId, principal) => {
      const r = resumoDoResultadoKit(resultadoIncerto(arma, linkDocId, principal), {
        ...OPCOES_KIT,
        projectId: 'demo-erp',
      });
      const cmd = lerArgsPublicar(argvDoComando(r.comandoDeRetomada ?? '', 'publicar:anuncio'));
      expect(cmd.kind).toBe('publicar');
      if (cmd.kind !== 'publicar') return;
      expect(cmd.args).toMatchObject({
        integracaoId: INTEGRACAO_ID,
        produtoId: KIT_PRODUTO,
        linkDocId,
        principal,
        recriar: arma === 'kit-recriar',
        converterEmKit: arma === 'kit-converter',
        live: true,
        projectId: 'demo-erp',
      });
    },
  );

  it('⛔ QUASE-PAR: o --project só entra no comando quando foi passado', () => {
    const sem = resumoDoResultadoKit(resultadoIncerto('kit-criar', null, null), OPCOES_KIT);
    expect(sem.comandoDeRetomada).not.toContain('--project');
    expect(sem.comandoDeRetomada?.endsWith(' --live')).toBe(true);
  });

  it('⚠️ PAR (L8): depois de um converter, o anúncio comum SUBSTITUÍDO continua vivo — o resumo dá o reverificar:anuncio EXATO, aceito pelo parser DELE', () => {
    const res = resultadoKit({
      arma: 'kit-converter',
      antecessor: {
        itemId: 2500139861,
        linkDocId: VINCULO_COMUM,
        excluido: false,
        substituido: true,
      },
    });
    const r = resumoDoResultadoKit(res, { ...OPCOES_KIT, projectId: 'demo-erp' });
    const texto = renderizarResultadoKit(res, { ...OPCOES_KIT, projectId: 'demo-erp' }).join('\n');

    expect(texto).toContain('SUBSTITUÍDO — continua vivo na Shopee');
    expect(texto).toContain('exclua-o no Seller Centre');
    const cmd = lerArgsReverificar(
      argvDoComando(r.comandoReverificar ?? '', 'reverificar:anuncio'),
    );
    expect(cmd).toEqual({
      kind: 'reverificar',
      args: {
        integracaoId: INTEGRACAO_ID,
        produtoId: KIT_PRODUTO,
        linkDocId: VINCULO_COMUM,
        json: false,
        projectId: 'demo-erp',
      },
    });
  });

  it('⛔ QUASE-PAR: um recriar cujo delete DEU CERTO, ou que parou no portão (antigo intocado), NÃO pede reverificar', () => {
    const excluido = resultadoKit({
      arma: 'kit-recriar',
      antecessor: {
        itemId: KIT_ITEM,
        linkDocId: VINCULO_ANTIGO,
        excluido: true,
        substituido: false,
      },
    });
    const intocado = resultadoKit({
      arma: 'kit-recriar',
      antecessor: {
        itemId: KIT_ITEM,
        linkDocId: VINCULO_ANTIGO,
        excluido: false,
        substituido: false,
      },
    });
    expect(resumoDoResultadoKit(excluido, OPCOES_KIT).comandoReverificar).toBeNull();
    expect(resumoDoResultadoKit(intocado, OPCOES_KIT).comandoReverificar).toBeNull();
    expect(renderizarResultadoKit(excluido, OPCOES_KIT).join('\n')).toContain('EXCLUÍDO na Shopee');
    expect(renderizarResultadoKit(intocado, OPCOES_KIT).join('\n')).toContain('INTOCADO');
    // …e o recriar cujo delete NÃO pegou (substituído) pede, como o converter.
    const naoPegou = resultadoKit({
      arma: 'kit-recriar',
      antecessor: {
        itemId: KIT_ITEM,
        linkDocId: VINCULO_ANTIGO,
        excluido: false,
        substituido: true,
      },
    });
    expect(resumoDoResultadoKit(naoPegou, OPCOES_KIT).comandoReverificar).toContain(
      `--link ${VINCULO_ANTIGO}`,
    );
  });

  it('os avisos saem com código, produto e a frase de MECANISMO; a nota do sandbox só no sandbox', () => {
    const res = resultadoKit({
      avisos: [
        {
          codigo: 'receita-divergente',
          produtoId: 'kit-k-verde',
          mensagem: 'a variação kit-k-verde não ficou igual à composição do ERP',
        },
      ],
      avisosResolvidos: 1,
    });
    const texto = renderizarResultadoKit(res, OPCOES_KIT).join('\n');
    expect(texto).toContain('### avisos (1)');
    expect(texto).toContain('receita-divergente');
    expect(texto).toContain('kit-k-verde');
    expect(texto).toContain('1 resolvido(s)');
    expect(texto).not.toContain(NOTA_SANDBOX_SG_KIT);
    expect(renderizarResultadoKit(res, { ...OPCOES_KIT, sandbox: true }).join('\n')).toContain(
      NOTA_SANDBOX_SG_KIT,
    );
  });

  it('o --json passa por JSON.parse e chega ao mesmo objeto redigido', () => {
    const r = resumoDoResultadoKit(
      resultadoIncerto('kit-converter', VINCULO_COMUM, 'comp-a-filho'),
      OPCOES_KIT,
    );
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});
