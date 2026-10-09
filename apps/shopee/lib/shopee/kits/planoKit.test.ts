import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_LOGISTICS_FEE_TYPE,
  assertAddKitItemRequest,
  shopeeKitItemLimitPayloadSchema,
  shopeeLogisticsChannelSchema,
  type ShopeeLogisticsChannel,
} from '@delfrance/integrations-shopee';
import {
  NOME_TIER_KIT_UNICO,
  OPCAO_TIER_KIT_UNICO,
  chaveReceitaKitErp,
  type EnderecoShopeeDoComponente,
  type ResolucaoComponenteKit,
} from '@delfrance/schemas';

import { MOTIVO_PUBLICACAO_BLOQUEADA } from '../anuncios/errosPublicacao';
import type { FotosResolvidas } from '../anuncios/planoPublicacao';
import { CAP_FOTOS_KIT } from './constantesKit';
import type { AchadoKitPorSku } from './localizarKitPorSku';
import {
  chaveReceitaArmazenadaDoFilho,
  decidirKitNovo,
  opcaoDoTierKit,
  planejarKit,
  problemaVinculoSubstituido,
  problemaVinculosAmbiguos,
  problemasDaFaseA,
  situacaoDoSkuDoKit,
  tetoDeFotosDoKit,
  vinculosNativosDoKit,
  type EntradaDaFaseA,
} from './planoKit';
import type { ContextoKit, FilhoDoKit, VinculoDaConta } from './resultadoKit';

/**
 * R2-F3: step 9's rung-2 fold, WIDENABLE per test. Every SKU guard in
 * `planoKit.ts` must ASK `skuDoItemShopee` rather than re-derive its scope; the
 * "wider fold" cases switch it to one that also collapses inner whitespace and
 * assert the guards moved with it. Off (the real fold) everywhere else.
 */
const dobraDoImport = vi.hoisted(() => ({ larga: false }));
vi.mock('../produtos/resolveProduto', async (importOriginal) => {
  const real = await importOriginal<typeof import('../produtos/resolveProduto')>();
  return {
    ...real,
    skuDoItemShopee: (base: { readonly item_sku?: string | null }): string =>
      dobraDoImport.larga
        ? (base.item_sku ?? '').trim().replace(/\s+/g, ' ')
        : real.skuDoItemShopee(base),
  };
});

afterEach(() => {
  dobraDoImport.larga = false;
});

/* -------------------------------------------------------------------------- */
/*  Fixtures — ids by ROLE (kit 2500139870/2000458820, second kit 2500139873,  */
/*  A 2500139871/2000458821, B 2500139872 plain); never a real id.             */
/* -------------------------------------------------------------------------- */

const K = 'prod-kit';
const MEMBRO = 'prod-kit-membro';
const F_AZUL = 'prod-kit-azul';
const F_PRETO = 'prod-kit-preto';
const F_VERDE = 'prod-kit-verde';
const A = 'prod-comp-a';
const B = 'prod-comp-b';
const X = 'prod-comp-x';
const ITEM_A = 2500139871;
const MODELO_A = 2000458821;
const MODELO_ANEXADO = 2000458822;
const ITEM_B = 2500139872;
const KIT = 2500139870;
const KIT_2 = 2500139873;
const CANAL = 90003;

const ENDERECO_A: EnderecoShopeeDoComponente = { itemId: ITEM_A, modelId: MODELO_A };
const ENDERECO_B: EnderecoShopeeDoComponente = { itemId: ITEM_B, modelId: null };

type Receita = FilhoDoKit['componentesKit'];

const RECEITA: Receita = {
  [A]: { quantidade: 1, limitarEstoque: true },
  [B]: { quantidade: 2, limitarEstoque: true },
};

function resolucao(
  extra: readonly (readonly [string, ResolucaoComponenteKit])[] = [],
): Map<string, ResolucaoComponenteKit> {
  return new Map<string, ResolucaoComponenteKit>([
    [A, { ok: true, endereco: ENDERECO_A }],
    [B, { ok: true, endereco: ENDERECO_B }],
    ...extra,
  ]);
}

function filho(produtoId: string, over: Partial<FilhoDoKit> = {}): FilhoDoKit {
  return {
    produtoId,
    sku: `SKU-${produtoId}`,
    ordem: 1,
    componentesKit: RECEITA,
    preco: 59.9,
    variante: null,
    ...over,
  };
}

function canal(): ShopeeLogisticsChannel {
  return shopeeLogisticsChannelSchema.parse({
    logistics_channel_id: CANAL,
    enabled: true,
    fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
  });
}

const RAW_DO_KIT: Record<string, unknown> = {
  nome: 'Kit presente',
  sku: 'KIT-1',
  pesoBrutoKg: 1.2,
  pesoLiquidoKg: 1,
  alturaCm: 10.2,
  larguraCm: 20,
  profundidadeCm: 30,
  componentesKit: RECEITA,
};

function buscaVazia(): NonNullable<ContextoKit['busca']> {
  return { completo: true, achados: [], paginas: 1, chamadas: 1 };
}

function busca(
  achados: readonly AchadoKitPorSku[],
  completo = true,
): NonNullable<ContextoKit['busca']> {
  return { completo, achados, paginas: 1, chamadas: 2 };
}

function contexto(over: Partial<ContextoKit> = {}): ContextoKit {
  return {
    arma: { arma: 'kit-criar' },
    integracaoId: 'int-1',
    produto: { id: K, sku: 'KIT-1', raw: RAW_DO_KIT },
    filhos: [filho(MEMBRO)],
    familiaDeUm: true,
    grupo: null,
    gruposDistintos: 0,
    descricao: 'Kit com dois componentes.',
    resolucao: resolucao(),
    temModelos: new Map([
      [ITEM_A, true],
      [ITEM_B, false],
    ]),
    categoriaPorProduto: new Map(),
    principal: ENDERECO_A,
    principalPedido: ENDERECO_A,
    limites: { estado: 'indisponivel' },
    canais: [canal()],
    vinculos: [],
    alvo: null,
    vivo: null,
    linhasDoAnuncio: [],
    linhasDaConta: [],
    busca: buscaVazia(),
    nossosVivos: new Map(),
    ...over,
  };
}

/** A two-child family on ONE axis (`Cor`): azul then preto. */
function familia(over: Partial<ContextoKit> = {}): ContextoKit {
  return contexto({
    familiaDeUm: false,
    grupo: { id: 'g-cor', nome: 'Cor' },
    gruposDistintos: 1,
    filhos: [
      filho(F_AZUL, { variante: 'Azul', ordem: 1 }),
      filho(F_PRETO, {
        variante: 'Preto',
        ordem: 2,
        componentesKit: { [A]: { quantidade: 1 }, [B]: { quantidade: 3 } },
        preco: 64.9,
      }),
    ],
    ...over,
  });
}

function atualizar(over: Partial<ContextoKit> = {}): ContextoKit {
  return contexto({
    arma: { arma: 'kit-atualizar', linkDocId: 'link-kit' },
    alvo: {
      linkDocId: 'link-kit',
      raw: { item_id: KIT, kitNativo: true, item_name: 'Kit vivo', description: 'Descrição viva' },
    },
    busca: null,
    principal: ENDERECO_A,
    principalPedido: null,
    ...over,
  });
}

function fotos(imageIds: readonly string[] = ['img-1', 'img-2']): FotosResolvidas {
  return {
    item: {
      imageIds,
      reutilizadas: 0,
      enviadas: imageIds.length,
      falhas: [],
      consideradas: imageIds.length,
      descartadasPeloLimite: 0,
    },
    imagensDeOpcao: null,
    tabelaDeMedidas: null,
    resumo: {
      consideradas: imageIds.length,
      reutilizadas: 0,
      enviadas: imageIds.length,
      falhas: 0,
      descartadasPeloLimite: 0,
    },
  };
}

function servidos(bandas: Record<string, unknown>): ContextoKit['limites'] {
  return { estado: 'servido', limites: shopeeKitItemLimitPayloadSchema.parse(bandas) };
}

function vinculo(id: string, raw: Record<string, unknown>): VinculoDaConta {
  return { id, raw };
}

function motivos(problemas: readonly { readonly motivo: string }[]): string[] {
  return problemas.map((p) => p.motivo);
}

function faseA(over: Partial<EntradaDaFaseA> = {}): EntradaDaFaseA {
  const ctx = contexto();
  return {
    arma: ctx.arma,
    produto: ctx.produto,
    filhos: ctx.filhos,
    familiaDeUm: ctx.familiaDeUm,
    grupo: ctx.grupo,
    gruposDistintos: ctx.gruposDistintos,
    descricao: ctx.descricao,
    raizesComOSku: [K],
    ...over,
  };
}

const M = MOTIVO_PUBLICACAO_BLOQUEADA;

/* -------------------------------------------------------------------------- */
/*                                  Fase A                                    */
/* -------------------------------------------------------------------------- */

describe('problemasDaFaseA — as recusas que só leem o Firestore', () => {
  it('o fixture completo não recusa nada (sem isso, cada caso abaixo é vácuo)', () => {
    expect(problemasDaFaseA(faseA())).toEqual([]);
  });

  it('M84 — lista TODA falta, na ordem do seam, nunca só a primeira', () => {
    const filhos = Array.from({ length: 10 }, (_, i) =>
      filho(`prod-f${String(i)}`, { componentesKit: i === 0 ? null : RECEITA }),
    );
    const problemas = problemasDaFaseA(
      faseA({
        produto: { id: K, sku: null, raw: {} },
        filhos,
        familiaDeUm: false,
        gruposDistintos: 2,
        descricao: null,
      }),
    );
    expect(motivos(problemas)).toEqual([
      M.kitSemSku,
      M.semNome,
      M.semDescricao,
      M.semPeso,
      M.semDimensoes,
      M.kitSemComponentes,
      M.kitVariacoesDemais,
      M.kitDoisEixos,
    ]);
  });

  it('kit-sem-unidade-vendavel: sem filho algum — e a frase do seam, com o id', () => {
    const problemas = problemasDaFaseA(faseA({ filhos: [] }));
    expect(problemas).toEqual([
      {
        campo: 'filhoUnicoId',
        motivo: M.kitSemUnidadeVendavel,
        mensagem:
          'o kit prod-kit não tem variação vendável — salve o produto no ERP para criar a ' +
          'variação única antes de publicar',
      },
    ]);
  });

  it('M90 — SKU nulo, em branco ou com espaços nas pontas recusa; o limpo passa', () => {
    const comSku = (sku: string | null) =>
      motivos(problemasDaFaseA(faseA({ produto: { id: K, sku, raw: RAW_DO_KIT } })));
    expect(comSku(null)).toEqual([M.kitSemSku]);
    expect(comSku('   ')).toEqual([M.kitSemSku]);
    expect(comSku('KIT-1 ')).toEqual([M.kitSkuComEspacos]);
    expect(comSku(' KIT-1')).toEqual([M.kitSkuComEspacos]);
    // ⛔ QUASE-PAR: espaço no MEIO não é das pontas, e caixa não é espaço.
    expect(comSku('KIT 1')).toEqual([]);
    expect(comSku('kit-1')).toEqual([]);
  });

  it('M97 — kit-sku-repetido nomeia o OUTRO pai, nunca K; só K na resposta passa', () => {
    const problemas = problemasDaFaseA(faseA({ raizesComOSku: [K, 'prod-outro-pai'] }));
    expect(motivos(problemas)).toEqual([M.kitSkuRepetido]);
    expect(problemas[0]?.mensagem).toContain('(prod-outro-pai)');
    expect(problemas[0]?.mensagem).not.toContain(`(${K}`);
    expect(problemasDaFaseA(faseA({ raizesComOSku: [K] }))).toEqual([]);
    // Não rodada (null) ⇒ a linha nem existe.
    expect(problemasDaFaseA(faseA({ raizesComOSku: null }))).toEqual([]);
    // Um SKU com espaços já recusou: a consulta do degrau 2 não acharia K.
    expect(
      motivos(
        problemasDaFaseA(
          faseA({
            produto: { id: K, sku: 'KIT-1 ', raw: RAW_DO_KIT },
            raizesComOSku: [K, 'prod-outro-pai'],
          }),
        ),
      ),
    ).toEqual([M.kitSkuComEspacos]);
  });

  it('M93 — dois grupos ⇒ kit-dois-eixos; um grupo, ou um filho só, passa', () => {
    const dois = [filho(F_AZUL, { variante: 'Azul' }), filho(F_PRETO, { variante: 'P' })];
    expect(
      motivos(problemasDaFaseA(faseA({ filhos: dois, familiaDeUm: false, gruposDistintos: 2 }))),
    ).toEqual([M.kitDoisEixos]);
    expect(
      problemasDaFaseA(faseA({ filhos: dois, familiaDeUm: false, gruposDistintos: 1 })),
    ).toEqual([]);
    expect(problemasDaFaseA(faseA({ gruposDistintos: 0 }))).toEqual([]);
  });

  it('M93b — três filhos SEM grupo algum ⇒ kit-dois-eixos dizendo que FALTA o eixo; dois grupos mantêm a frase de eixos demais', () => {
    // Numa criação, a fase A lança antes do `planejarTier`: esta é a ÚNICA frase
    // que o operador lê — "varia em 0 grupos" diria eixos DEMAIS a quem não tem eixo.
    // TRÊS filhos, nunca dois: com 2 filhos em 2 grupos a contagem de filhos e a de
    // grupos coincidem, e uma frase que trocasse uma pela outra passaria.
    const semGrupo = [filho(F_AZUL), filho(F_PRETO), filho(F_VERDE)];
    expect(
      problemasDaFaseA(faseA({ filhos: semGrupo, familiaDeUm: false, gruposDistintos: 0 })),
    ).toEqual([
      {
        campo: 'grupoDeVariacoesUid',
        motivo: M.kitDoisEixos,
        mensagem:
          'as 3 variações do kit não estão em nenhum grupo de variação — a Shopee aceita kit ' +
          'com UM eixo de variação; coloque-as num mesmo grupo de variação no ERP antes de publicar',
      },
    ]);
    // ⛔ QUASE-PAR: três filhos em dois grupos seguem com a frase de eixos DEMAIS,
    // intacta — e ela nomeia os 2 GRUPOS, nunca os 3 filhos.
    const emDoisGrupos = [
      filho(F_AZUL, { variante: 'Azul' }),
      filho(F_PRETO, { variante: 'Preto' }),
      filho(F_VERDE, { variante: 'P' }),
    ];
    expect(
      problemasDaFaseA(faseA({ filhos: emDoisGrupos, familiaDeUm: false, gruposDistintos: 2 })),
    ).toEqual([
      {
        campo: 'grupoDeVariacoesUid',
        motivo: M.kitDoisEixos,
        mensagem: 'a Shopee aceita kit com UM eixo de variação; este varia em 2 grupos',
      },
    ]);
  });

  it('kit-variacoes-demais: 10 filhos recusa (nomeando 10); 9 passa', () => {
    const n = (k: number) =>
      Array.from({ length: k }, (_, i) =>
        filho(`prod-f${String(i)}`, { variante: `v${String(i)}` }),
      );
    const dez = problemasDaFaseA(faseA({ filhos: n(10), familiaDeUm: false, gruposDistintos: 1 }));
    expect(motivos(dez)).toEqual([M.kitVariacoesDemais]);
    expect(dez[0]?.mensagem).toBe('a Shopee aceita no máximo 9 variações num kit; este tem 10');
    expect(
      problemasDaFaseA(faseA({ filhos: n(9), familiaDeUm: false, gruposDistintos: 1 })),
    ).toEqual([]);
  });

  it('kit-atualizar: só sem-nome / sem-descricao / sem-peso / sem-dimensoes recusam', () => {
    const problemas = problemasDaFaseA(
      faseA({
        arma: { arma: 'kit-atualizar', linkDocId: 'link-kit' },
        produto: { id: K, sku: null, raw: {} },
        filhos: [],
        gruposDistintos: 3,
        descricao: null,
        raizesComOSku: null,
      }),
    );
    expect(motivos(problemas)).toEqual([M.semNome, M.semDescricao, M.semPeso, M.semDimensoes]);
  });

  it('kit-atualizar lê o nome e a descrição VIVOS primeiro; uma criação lê só os do ERP', () => {
    const alvo = { linkDocId: 'link-kit', raw: { item_name: 'Kit vivo', description: 'viva' } };
    const semNoErp = { id: K, sku: 'KIT-1', raw: { ...RAW_DO_KIT, nome: '  ' } };
    expect(
      problemasDaFaseA(
        faseA({
          arma: { arma: 'kit-atualizar', linkDocId: 'link-kit' },
          produto: semNoErp,
          descricao: null,
          alvo,
        }),
      ),
    ).toEqual([]);
    // ⛔ QUASE-PAR: a mesma leitura numa CRIAÇÃO não vê o anúncio vivo.
    expect(motivos(problemasDaFaseA(faseA({ produto: semNoErp, descricao: null, alvo })))).toEqual([
      M.semNome,
      M.semDescricao,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        Os vínculos nativos de K                             */
/* -------------------------------------------------------------------------- */

describe('vinculosNativosDoKit', () => {
  it('separa ativo, substituído e removido; exclui o alvo; guarda o sucessor', () => {
    const v = vinculosNativosDoKit(
      [
        vinculo('link-ativo', { kitNativo: true, item_id: KIT }),
        vinculo('link-velho', {
          kitNativo: true,
          item_id: KIT_2,
          substituidoPorLinkDocId: 'link-ativo',
        }),
        vinculo('link-removido', {
          kitNativo: true,
          item_id: 2500139861,
          estadoAnuncio: 'removido',
        }),
        // ⛔ QUASE-PAR: substituído E removido (o kit antigo já saiu da Shopee) não
        // é mais um kit próprio que a busca possa achar.
        vinculo('link-velho-removido', {
          kitNativo: true,
          item_id: 2500139861,
          substituidoPorLinkDocId: 'link-ativo',
          estadoAnuncio: 'removido',
        }),
        // ⛔ QUASE-PAR: um anúncio COMUM substituído (o converter) não é kit.
        vinculo('link-comum-substituido', {
          kitNativo: false,
          item_id: 2500139861,
          substituidoPorLinkDocId: 'link-ativo',
        }),
        vinculo('link-comum', { kitNativo: false, item_id: 2500139861 }),
        vinculo('link-sem-item', { kitNativo: true, item_id: 0 }),
      ],
      null,
    );
    expect([...v.nossos]).toEqual([[KIT, 'link-ativo']]);
    expect([...v.substituidos]).toEqual([[KIT_2, 'link-velho']]);
    expect([...v.sucessorDe]).toEqual([['link-velho', 'link-ativo']]);

    const semAlvo = vinculosNativosDoKit(
      [vinculo('link-ativo', { kitNativo: true, item_id: KIT })],
      'link-ativo',
    );
    expect(semAlvo.nossos.size).toBe(0);
  });

  it('dois vínculos do MESMO item: vence o lexicamente primeiro, em toda execução', () => {
    const lista = [
      vinculo('link-b', { kitNativo: true, item_id: KIT }),
      vinculo('link-a', { kitNativo: true, item_id: KIT }),
    ];
    expect(vinculosNativosDoKit(lista, null).nossos.get(KIT)).toBe('link-a');
    expect(vinculosNativosDoKit([...lista].reverse(), null).nossos.get(KIT)).toBe('link-a');
  });
});

/* -------------------------------------------------------------------------- */
/*                               decidirKitNovo                                */
/* -------------------------------------------------------------------------- */

describe('decidirKitNovo — "garanta que o kit novo existe" (L9, R-14)', () => {
  const nenhum = new Map<number, string>();
  const semStatus = new Map<number, string | null>();

  it('nada na busca e nenhum vínculo ⇒ criar', () => {
    expect(decidirKitNovo(buscaVazia(), nenhum, semStatus, nenhum)).toEqual({ acao: 'criar' });
  });

  it('busca incompleta ⇒ busca-de-kit-incompleta, nada criado', () => {
    const r = decidirKitNovo(busca([], false), nenhum, semStatus, nenhum);
    expect(r.acao).toBe('recusar');
    expect(r.acao === 'recusar' ? motivos(r.problemas) : []).toEqual([M.buscaDeKitIncompleta]);
  });

  it('M81/M89 — um achado que não é nosso recusa "importe-o"; o vinculado a outro produto é nomeado', () => {
    const r = decidirKitNovo(
      busca([
        { itemId: KIT_2, vinculo: { produtoId: 'prod-outro', linkDocId: 'link-outro' } },
        { itemId: KIT, vinculo: null },
      ]),
      nenhum,
      semStatus,
      nenhum,
    );
    expect(r).toEqual({
      acao: 'recusar',
      problemas: [
        {
          campo: 'sku',
          motivo: M.kitJaExisteNaShopee,
          mensagem:
            'já existe na Shopee um kit com o SKU deste produto (item 2500139870, 2500139873) — ' +
            'importe-o (importar:anuncio) em vez de criar outro (item 2500139873 já vinculado ao ' +
            'produto prod-outro)',
        },
      ],
    });
  });

  it('M165 — OURS vem do VÍNCULO: o kit ligado que a lista ainda não mostra é completado, nunca recriado', () => {
    const nossos = new Map([[KIT, 'link-1']]);
    // A busca não listou o kit (latência de ~9 s), mas a leitura em lote diz que ele vive.
    expect(decidirKitNovo(buscaVazia(), nossos, new Map([[KIT, 'NORMAL']]), nenhum)).toEqual({
      acao: 'completar',
      linkDocId: 'link-1',
      itemId: KIT,
    });
    // A busca o listou ⇒ o mesmo veredito, sem precisar da leitura.
    expect(
      decidirKitNovo(busca([{ itemId: KIT, vinculo: null }]), nossos, semStatus, nenhum),
    ).toEqual({ acao: 'completar', linkDocId: 'link-1', itemId: KIT });
    // ⛔ QUASE-PAR: lido como excluído (null) ⇒ não é nosso ⇒ criar.
    expect(decidirKitNovo(buscaVazia(), nossos, new Map([[KIT, null]]), nenhum)).toEqual({
      acao: 'criar',
    });
    // O escopo do "existe": BANNED e REVIEWING ainda seguram o SKU; SELLER_DELETE não.
    expect(decidirKitNovo(buscaVazia(), nossos, new Map([[KIT, 'BANNED']]), nenhum).acao).toBe(
      'completar',
    );
    expect(decidirKitNovo(buscaVazia(), nossos, new Map([[KIT, 'REVIEWING']]), nenhum).acao).toBe(
      'completar',
    );
    expect(
      decidirKitNovo(buscaVazia(), nossos, new Map([[KIT, 'SELLER_DELETE']]), nenhum).acao,
    ).toBe('criar');
  });

  it('M166 — um achado no kit SUBSTITUÍDO do próprio K recusa vinculo-substituido, nunca "importe-o"', () => {
    const r = decidirKitNovo(
      busca([{ itemId: KIT_2, vinculo: { produtoId: K, linkDocId: 'link-velho' } }]),
      nenhum,
      semStatus,
      new Map([[KIT_2, 'link-velho']]),
      new Map([['link-velho', 'link-novo']]),
    );
    expect(r.acao).toBe('recusar');
    const problemas = r.acao === 'recusar' ? r.problemas : [];
    expect(motivos(problemas)).toEqual([M.vinculoSubstituido]);
    expect(problemas[0]?.mensagem).toContain('link-velho');
    expect(problemas[0]?.mensagem).toContain('--link link-novo');
    expect(problemas[0]?.mensagem).not.toContain('importe-o');
  });

  it('M180 — substituído próprio + estrangeiro, nas DUAS ordens da lista ⇒ UMA recusa com os dois', () => {
    const proprio = { itemId: KIT_2, vinculo: { produtoId: K, linkDocId: 'link-velho' } };
    const estranho = { itemId: KIT, vinculo: null };
    const substituidos = new Map([[KIT_2, 'link-velho']]);
    for (const achados of [
      [proprio, estranho],
      [estranho, proprio],
    ]) {
      const r = decidirKitNovo(busca(achados), nenhum, semStatus, substituidos);
      expect(r.acao).toBe('recusar');
      const problemas = r.acao === 'recusar' ? r.problemas : [];
      expect(motivos(problemas)).toEqual([M.vinculoSubstituido, M.kitJaExisteNaShopee]);
      expect(problemas[1]?.mensagem).toContain('(item 2500139870)');
      expect(problemas[1]?.mensagem).not.toContain('2500139873');
    }
  });

  it('dois kits NOSSOS vivos ⇒ vinculos-ambiguos nomeando os dois', () => {
    const r = decidirKitNovo(
      busca([
        { itemId: KIT, vinculo: { produtoId: K, linkDocId: 'link-1' } },
        { itemId: KIT_2, vinculo: { produtoId: K, linkDocId: 'link-2' } },
      ]),
      new Map([
        [KIT, 'link-1'],
        [KIT_2, 'link-2'],
      ]),
      semStatus,
      nenhum,
    );
    expect(r.acao).toBe('recusar');
    const problemas = r.acao === 'recusar' ? r.problemas : [];
    expect(motivos(problemas)).toEqual([M.vinculosAmbiguos]);
    expect(problemas[0]?.mensagem).toContain(
      'o produto tem 2 kits nativos ativos nesta conta (link-1 (item 2500139870), link-2 (item 2500139873))',
    );
  });
});

describe('as frases compartilhadas com o despachante (PR 7)', () => {
  it('vinculos-ambiguos — o texto do seam, sem a etiqueta de revisão', () => {
    expect(
      problemaVinculosAmbiguos([
        { linkDocId: 'link-1', itemId: KIT },
        { linkDocId: 'link-2', itemId: null },
      ]),
    ).toEqual({
      campo: 'linkDocId',
      motivo: M.vinculosAmbiguos,
      mensagem:
        'o produto tem 2 kits nativos ativos nesta conta (link-1 (item 2500139870), link-2) — ' +
        'informe qual com --link; se uma recriação foi interrompida, termine-a com --link ' +
        '<kit antigo> --recriar (se o --link apontar o kit novo, nada é excluído e a resposta ' +
        'diz qual é o antigo)',
    });
  });

  it('vinculo-substituido — nomeia o sucessor quando conhecido; sem ele, nenhum --link inventado', () => {
    expect(
      problemaVinculoSubstituido({
        linkDocId: 'link-velho',
        itemId: KIT_2,
        novoLinkDocId: 'link-novo',
      }).mensagem,
    ).toBe(
      'vínculo link-velho (item 2500139873): este anúncio foi substituído pelo kit nativo ' +
        'link-novo e não é mais publicado pelo ERP — publique sem --link (ou com --link ' +
        'link-novo); se ele ainda estiver ativo na Shopee, exclua-o no Seller Centre (para um ' +
        'kit antigo cuja exclusão falhou, --recriar com este --link tenta excluí-lo de novo)',
    );
    const semNovo = problemaVinculoSubstituido({
      linkDocId: 'link-velho',
      itemId: null,
      novoLinkDocId: null,
    }).mensagem;
    expect(semNovo).toContain('substituído por outro kit nativo');
    expect(semNovo).not.toContain('ou com --link');
  });
});

/* -------------------------------------------------------------------------- */
/*                                 planejarKit                                 */
/* -------------------------------------------------------------------------- */

describe('planejarKit — a criação de uma família de um', () => {
  it('monta o corpo inteiro, que o guarda do PACOTE aceita', () => {
    const plano = planejarKit(contexto(), fotos());
    expect(plano.problemas).toEqual([]);
    expect(plano.kitNovo).toEqual({ acao: 'criar' });
    expect(plano.sku).toBe('KIT-1');
    expect(plano.principal).toEqual(ENDERECO_A);
    const corpo = plano.corpo;
    expect(corpo).not.toBeNull();
    if (corpo === null) return;
    expect(() => assertAddKitItemRequest(corpo)).not.toThrow();
    expect(corpo.sync_setting).toEqual({ auto_sync_dts: true });
    expect(corpo.item_setting).toMatchObject({
      item_name: 'Kit presente',
      images: { image_id_list: ['img-1', 'img-2'] },
      description_type: 'normal',
      description: 'Kit com dois componentes.',
      weight: 1.2,
      item_sku: 'KIT-1',
    });
    expect(corpo.item_setting.logistic_info.map((l) => l.logistic_id)).toEqual([CANAL]);
    // ⚠️ Nenhum categoria/atributo/marca: a Shopee copia do principal.
    expect(Object.keys(corpo.item_setting)).not.toContain('category_id');
    expect(corpo.item_setting.model_list).toEqual([
      {
        tier_index: [0],
        original_price: 59.9,
        model_sku: `SKU-${MEMBRO}`,
        component_list: [
          {
            component_item_id: ITEM_A,
            component_model_id: MODELO_A,
            quantity: 1,
            main_component: true,
          },
          { component_item_id: ITEM_B, quantity: 2 },
        ],
      },
    ]);
    // O item SEM variações vai sem `component_model_id` — nunca 0.
    expect(
      'component_model_id' in (corpo.item_setting.model_list[0]?.component_list[1] ?? {}),
    ).toBe(false);
    expect(plano.modelos).toEqual([
      {
        filhoId: MEMBRO,
        tierIndex: 0,
        linhas: corpo.item_setting.model_list[0]?.component_list,
        projecaoCompleta: true,
      },
    ]);
  });

  it("M87 — o tier de uma família de um é exatamente 'Kit' / 'Padrão' (L10(1))", () => {
    const corpo = planejarKit(contexto(), fotos()).corpo;
    expect(corpo?.item_setting.tier_variation_list).toEqual([
      { name: NOME_TIER_KIT_UNICO, option_list: [{ option: OPCAO_TIER_KIT_UNICO }] },
    ]);
    expect(NOME_TIER_KIT_UNICO).toBe('Kit');
    expect(OPCAO_TIER_KIT_UNICO).toBe('Padrão');
  });

  it('M96 — dois itens sem --principal ⇒ principal-obrigatorio, nunca um padrão silencioso', () => {
    const plano = planejarKit(contexto({ principal: null, principalPedido: null }), fotos());
    expect(motivos(plano.problemas)).toEqual([M.principalObrigatorio]);
    expect(plano.corpo).toBeNull();
    // ⛔ QUASE-PAR: UM item só ⇒ o padrão é ele, sem recusa.
    const umItem = planejarKit(
      contexto({
        principal: null,
        principalPedido: null,
        filhos: [filho(MEMBRO, { componentesKit: { [A]: { quantidade: 2 } } })],
        produto: {
          id: K,
          sku: 'KIT-1',
          raw: { ...RAW_DO_KIT, componentesKit: { [A]: { quantidade: 2 } } },
        },
      }),
      fotos(),
    );
    expect(umItem.problemas).toEqual([]);
    expect(umItem.principal).toEqual(ENDERECO_A);
  });

  it('principal-invalido: o --principal não está na composição — nomeado pelo endereço', () => {
    const fora: EnderecoShopeeDoComponente = { itemId: ITEM_A, modelId: MODELO_ANEXADO };
    const plano = planejarKit(contexto({ principal: fora, principalPedido: fora }), fotos());
    expect(plano.problemas).toEqual([
      {
        campo: 'principal',
        motivo: M.principalInvalido,
        mensagem:
          'o componente principal item 2500139871 modelo 2000458822 não faz parte da composição do kit',
      },
    ]);
  });

  it('principal-invalido nomeia o PRODUTO do --principal quando a resolução o conhece', () => {
    const enderecoX: EnderecoShopeeDoComponente = { itemId: KIT_2, modelId: null };
    const plano = planejarKit(
      contexto({
        resolucao: resolucao([[X, { ok: true, endereco: enderecoX }]]),
        principal: enderecoX,
        principalPedido: enderecoX,
      }),
      fotos(),
    );
    expect(plano.problemas.map((p) => p.mensagem)).toEqual([
      `o componente principal ${X} não faz parte da composição do kit`,
    ]);
  });

  it('M94 — K ≠ variação única: vai a receita da VARIAÇÃO + receita-espelho-divergente', () => {
    const doKit = { [A]: { quantidade: 1 }, [B]: { quantidade: 3 } };
    const plano = planejarKit(
      contexto({ produto: { id: K, sku: 'KIT-1', raw: { ...RAW_DO_KIT, componentesKit: doKit } } }),
      fotos(),
    );
    expect(plano.avisos).toEqual([
      {
        codigo: 'receita-espelho-divergente',
        produtoId: K,
        mensagem: `a composição do kit ${K} difere da da variação única ${MEMBRO}; foi usada a da variação`,
      },
    ]);
    expect(plano.corpo?.item_setting.model_list[0]?.component_list[1]).toEqual({
      component_item_id: ITEM_B,
      quantity: 2,
    });
  });

  it('M94 (escopo) — ordem das chaves e limitarEstoque NÃO divergem; uma chave a mais diverge', () => {
    const espelho = (componentesKit: unknown) =>
      planejarKit(
        contexto({ produto: { id: K, sku: 'KIT-1', raw: { ...RAW_DO_KIT, componentesKit } } }),
        fotos(),
      ).avisos.filter((a) => a.codigo === 'receita-espelho-divergente');
    expect(
      espelho({ [B]: { quantidade: 2, limitarEstoque: false }, [A]: { quantidade: 1 } }),
    ).toEqual([]);
    expect(espelho({ ...RECEITA, [X]: { quantidade: 1 } })).toHaveLength(1);
  });

  it('L3 — um componente que não limita estoque VAI no corpo e vira aviso (uma vez só)', () => {
    const naoLimita: Receita = {
      [A]: { quantidade: 1, limitarEstoque: false },
      [B]: { quantidade: 2 },
    };
    const plano = planejarKit(
      familia({
        filhos: [
          filho(F_AZUL, { variante: 'Azul', componentesKit: naoLimita }),
          filho(F_PRETO, { variante: 'Preto', componentesKit: naoLimita }),
        ],
      }),
      fotos(),
    );
    expect(plano.problemas).toEqual([]);
    for (const modelo of plano.corpo?.item_setting.model_list ?? []) {
      expect(modelo.component_list.map((l) => l.component_item_id)).toContain(ITEM_A);
    }
    expect(plano.avisos).toEqual([
      {
        codigo: 'componente-nao-limita-estoque',
        produtoId: A,
        mensagem:
          `o componente ${A} está com «Limita estoque» desligado; a Shopee conta todos os ` +
          'componentes, então pode mostrar MENOS kits do que o ERP (nunca mais)',
      },
    ]);
  });
});

describe('planejarKit — a família (L2: um modelo por filho, UM tier)', () => {
  it('M87 — o tier é o grupo, as opções são as variantes, tier_index pela posição', () => {
    const plano = planejarKit(familia(), fotos());
    expect(plano.problemas).toEqual([]);
    const corpo = plano.corpo;
    expect(corpo).not.toBeNull();
    if (corpo === null) return;
    expect(() => assertAddKitItemRequest(corpo)).not.toThrow();
    expect(corpo.item_setting.tier_variation_list).toEqual([
      { name: 'Cor', option_list: [{ option: 'Azul' }, { option: 'Preto' }] },
    ]);
    expect(
      corpo.item_setting.model_list.map((m) => [m.tier_index, m.original_price, m.model_sku]),
    ).toEqual([
      [[0], 59.9, `SKU-${F_AZUL}`],
      [[1], 64.9, `SKU-${F_PRETO}`],
    ]);
    expect(plano.modelos.map((m) => [m.filhoId, m.tierIndex])).toEqual([
      [F_AZUL, 0],
      [F_PRETO, 1],
    ]);
  });

  it('L1/probe #2 — UM principal por KIT, marcado no PRIMEIRO modelo que o contém', () => {
    const marcados = (plano: ReturnType<typeof planejarKit>) =>
      (plano.corpo?.item_setting.model_list ?? []).map((m) =>
        m.component_list.filter((l) => l.main_component === true).map((l) => l.component_item_id),
      );
    // A está nos DOIS modelos ⇒ marcado só no modelo 0.
    expect(marcados(planejarKit(familia(), fotos()))).toEqual([[ITEM_A], []]);
    // ⛔ QUASE-PAR: B só no modelo 1 ⇒ a marca vai para o modelo 1, e só lá.
    const soNoSegundo = familia({
      principal: ENDERECO_B,
      principalPedido: ENDERECO_B,
      filhos: [
        filho(F_AZUL, { variante: 'Azul', componentesKit: { [A]: { quantidade: 2 } } }),
        filho(F_PRETO, { variante: 'Preto' }),
      ],
    });
    expect(marcados(planejarKit(soNoSegundo, fotos()))).toEqual([[], [ITEM_B]]);
  });

  it('combinacao-duplicada só quando as variantes coincidem APARADAS; caixa diferente não', () => {
    const com = (a: string, b: string) =>
      motivos(
        planejarKit(
          familia({
            filhos: [filho(F_AZUL, { variante: a }), filho(F_PRETO, { variante: b })],
          }),
          fotos(),
        ).problemas,
      );
    expect(com('Azul', ' Azul ')).toEqual([M.combinacaoDuplicada]);
    expect(com('Azul', 'azul')).toEqual([]);
  });

  it('um filho sem variante num kit de dois ⇒ variacao-sem-vinculo (não há opção para ele)', () => {
    const plano = planejarKit(
      familia({
        filhos: [filho(F_AZUL, { variante: 'Azul' }), filho(F_PRETO, { variante: null })],
      }),
      fotos(),
    );
    expect(motivos(plano.problemas)).toEqual([M.variacaoSemVinculo]);
    expect(plano.problemas[0]?.campo).toBe(`filhos.${F_PRETO}`);
    expect(plano.corpo).toBeNull();
  });
});

describe('planejarKit — as recusas da receita', () => {
  it('R-5 — um componente só com quantidade 1 recusa; 2 passa; duas chaves no MESMO endereço somam', () => {
    const umSo = (
      componentesKit: Receita,
      extra: readonly (readonly [string, ResolucaoComponenteKit])[] = [],
    ) =>
      planejarKit(
        contexto({
          filhos: [filho(MEMBRO, { componentesKit })],
          produto: { id: K, sku: 'KIT-1', raw: { ...RAW_DO_KIT, componentesKit } },
          resolucao: resolucao(extra),
        }),
        fotos(),
      );
    expect(motivos(umSo({ [A]: { quantidade: 1 } }).problemas)).toEqual([
      M.kitComponenteUnicoQuantidade,
    ]);
    expect(umSo({ [A]: { quantidade: 2 } }).problemas).toEqual([]);
    // Wrapper W + membro A no MESMO endereço: 1 + 1 = UMA linha de 2.
    const somado = umSo({ [A]: { quantidade: 1 }, 'prod-comp-w': { quantidade: 1 } }, [
      ['prod-comp-w', { ok: true, endereco: ENDERECO_A }],
    ]);
    expect(somado.problemas).toEqual([]);
    expect(somado.corpo?.item_setting.model_list[0]?.component_list).toEqual([
      {
        component_item_id: ITEM_A,
        component_model_id: MODELO_A,
        quantity: 2,
        main_component: true,
      },
    ]);
  });

  it('um componente sem anúncio recusa UMA vez, mesmo faltando em dois filhos', () => {
    const comX: Receita = { ...RECEITA, [X]: { quantidade: 1 } };
    const plano = planejarKit(
      familia({
        filhos: [
          filho(F_AZUL, { variante: 'Azul', componentesKit: comX }),
          filho(F_PRETO, { variante: 'Preto', componentesKit: comX }),
        ],
      }),
      fotos(),
    );
    expect(plano.problemas).toEqual([
      {
        campo: `componentesKit.${X}`,
        motivo: M.componenteNaoPublicado,
        mensagem: `o componente ${X} não tem anúncio nesta conta Shopee — publique-o (ou importe-o) antes do kit`,
      },
    ]);
    expect(plano.modelos.map((m) => m.projecaoCompleta)).toEqual([false, false]);
    expect(plano.corpo).toBeNull();
  });

  it('cada falha de resolução vira o seu motivo, com a frase do seam', () => {
    const comX: Receita = { ...RECEITA, [X]: { quantidade: 1 } };
    const frase = (motivo: ResolucaoComponenteKit) =>
      planejarKit(
        contexto({
          filhos: [filho(MEMBRO, { componentesKit: comX })],
          produto: { id: K, sku: 'KIT-1', raw: { ...RAW_DO_KIT, componentesKit: comX } },
          resolucao: resolucao([[X, motivo]]),
        }),
        fotos(),
      ).problemas;
    expect(frase({ ok: false, motivo: M.componenteEKitNativo })).toEqual([
      {
        campo: `componentesKit.${X}`,
        motivo: M.componenteEKitNativo,
        mensagem: `o componente ${X} é ele próprio um kit nativo da Shopee — kit de kits não é suportado`,
      },
    ]);
    expect(motivos(frase({ ok: false, motivo: M.componenteSemModelo }))).toEqual([
      M.componenteSemModelo,
    ]);
    expect(motivos(frase({ ok: false, motivo: M.componenteAnuncioInativo }))).toEqual([
      M.componenteAnuncioInativo,
    ]);
  });
});

describe('planejarKit — as faixas, SÓ quando os limites de kit são servidos (R-f)', () => {
  const onze = Array.from({ length: 11 }, (_, i) => `prod-comp-${String(i)}`);
  const receitaDeOnze: Receita = Object.fromEntries(onze.map((id) => [id, { quantidade: 1 }]));
  const resolucaoDeOnze = resolucao(
    onze.map((id, i) => [id, { ok: true, endereco: { itemId: 9001 + i, modelId: null } }] as const),
  );
  const principal: EnderecoShopeeDoComponente = { itemId: 9001, modelId: null };
  const comOnze = (limites: ContextoKit['limites']) =>
    planejarKit(
      contexto({
        filhos: [filho(MEMBRO, { componentesKit: receitaDeOnze })],
        produto: { id: K, sku: 'KIT-1', raw: { ...RAW_DO_KIT, componentesKit: receitaDeOnze } },
        resolucao: resolucaoDeOnze,
        principal,
        principalPedido: principal,
        limites,
      }),
      fotos(),
    );

  it('M85 — indisponível ⇒ a criação segue; servido máx 10 com 11 linhas ⇒ recusa local', () => {
    const indisponivel = comOnze({ estado: 'indisponivel' });
    expect(indisponivel.problemas).toEqual([]);
    expect(indisponivel.corpo).not.toBeNull();
    const servido = comOnze(
      servidos({ component_count_limit_of_single_model: { min_limit: 1, max_limit: 10 } }),
    );
    expect(servido.problemas).toEqual([
      {
        campo: 'componentesKit',
        motivo: M.componentesForaDaFaixa,
        mensagem: `a categoria do componente principal aceita de 1 a 10 componentes por variação; a variação ${MEMBRO} está fora`,
      },
    ]);
    expect(servido.corpo).toBeNull();
    // ⛔ QUASE-PAR: a mesma faixa com máx 11 aceita as 11.
    expect(
      comOnze(servidos({ component_count_limit_of_single_model: { min_limit: 1, max_limit: 11 } }))
        .problemas,
    ).toEqual([]);
    // Sem limites lidos (nenhuma categoria do principal) ⇒ também nenhuma faixa.
    expect(comOnze(null).problemas).toEqual([]);
  });

  it('preço, nome e descrição fora da faixa recusam só quando servida', () => {
    const faixas = servidos({
      price_limit: { min_limit: 1, max_limit: 50 },
      item_name_length_limit: { min_limit: 1, max_limit: 5 },
      description_limit: { description_length_min: 1, description_length_max: 10 },
    });
    const plano = planejarKit(contexto({ limites: faixas }), fotos());
    expect(motivos(plano.problemas)).toEqual([
      M.nomeForaDaFaixa,
      M.descricaoForaDaFaixa,
      M.precoForaDaFaixa,
    ]);
    expect(plano.problemas[2]?.campo).toBe('original_price');
    expect(
      planejarKit(contexto({ limites: { estado: 'indisponivel' } }), fotos()).problemas,
    ).toEqual([]);
  });

  it('sem preço: sem-preco na família de um, filho-sem-preco (campo do filho) na família', () => {
    expect(
      planejarKit(contexto({ filhos: [filho(MEMBRO, { preco: null })] }), fotos()).problemas,
    ).toEqual([
      {
        campo: 'original_price',
        motivo: M.semPreco,
        mensagem: `o kit ${K} não tem preço na tabela normal da conta (variação única ${MEMBRO})`,
      },
    ]);
    const familiaSemPreco = planejarKit(
      familia({
        filhos: [
          filho(F_AZUL, { variante: 'Azul' }),
          filho(F_PRETO, { variante: 'Preto', preco: null }),
        ],
      }),
      fotos(),
    );
    expect(familiaSemPreco.problemas).toEqual([
      {
        campo: `filhos.${F_PRETO}`,
        motivo: M.filhoSemPreco,
        mensagem: `a variação ${F_PRETO} do kit não tem preço na tabela normal da conta`,
      },
    ]);
  });
});

describe('planejarKit — as fotos da capa', () => {
  it('cap 9 (CAP_FOTOS_KIT), e a contagem servida quando menor', () => {
    const doze = Array.from({ length: 12 }, (_, i) => `img-${String(i)}`);
    expect(CAP_FOTOS_KIT).toBe(9);
    expect(planejarKit(contexto(), fotos(doze)).corpo?.item_setting.images.image_id_list).toEqual(
      doze.slice(0, 9),
    );
    const cinco = planejarKit(
      contexto({ limites: servidos({ item_image_count_limit: { min_limit: 1, max_limit: 5 } }) }),
      fotos(doze),
    );
    expect(cinco.corpo?.item_setting.images.image_id_list).toEqual(doze.slice(0, 5));
  });

  it('M184 — fotos null é "não resolvidas", nunca sem-fotos; uma lista VAZIA é sem-fotos', () => {
    const semPeso = {
      id: K,
      sku: 'KIT-1',
      raw: { ...RAW_DO_KIT, pesoBrutoKg: null, pesoLiquidoKg: null },
    };
    const naoResolvidas = planejarKit(atualizar({ produto: semPeso }), null);
    expect(motivos(naoResolvidas.problemas)).toEqual([M.semPeso]);
    const vazias = planejarKit(atualizar({ produto: semPeso }), fotos([]));
    expect(motivos(vazias.problemas)).toEqual([M.semPeso, M.semFotos]);
    // O mesmo na criação: fotos null não recusa e não monta corpo sem imagem.
    const criacao = planejarKit(contexto(), null);
    expect(criacao.problemas).toEqual([]);
    expect(criacao.corpo).toBeNull();
  });
});

describe('planejarKit — kit-atualizar (§2.6: nada recusa por receita)', () => {
  it('nem principal, nem receita, nem faixa de componentes recusam; nada é varrido', () => {
    const comX: Receita = { ...RECEITA, [X]: { quantidade: 1 } };
    const plano = planejarKit(
      atualizar({
        principal: null,
        filhos: [filho(MEMBRO, { componentesKit: comX })],
        limites: servidos({
          component_count_limit_of_single_model: { min_limit: 1, max_limit: 1 },
        }),
      }),
      fotos(),
    );
    expect(plano.problemas).toEqual([]);
    expect(plano.kitNovo).toBeNull();
    expect(plano.corpo).toBeNull();
    expect(plano.sku).toBe('KIT-1');
  });

  it('V2R1-07 — SKU vazio ou com espaços NÃO recusa a republicação: avisa e manda o vivo', () => {
    const plano = planejarKit(
      atualizar({ produto: { id: K, sku: 'KIT-1 ', raw: RAW_DO_KIT } }),
      fotos(),
    );
    expect(plano.problemas).toEqual([]);
    expect(plano.sku).toBeNull();
    expect(plano.avisos).toEqual([
      {
        codigo: 'sku-do-kit-nao-enviado',
        produtoId: K,
        mensagem:
          `o SKU do kit ${K} no ERP está vazio ou tem espaços nas pontas (${M.kitSkuComEspacos}); ` +
          'a publicação manteve o SKU que está na Shopee — corrija o SKU no ERP',
      },
    ]);
    const semSku = planejarKit(
      atualizar({ produto: { id: K, sku: null, raw: RAW_DO_KIT } }),
      fotos(),
    );
    expect(semSku.avisos[0]?.mensagem).toContain(`(${M.kitSemSku})`);
    // ⛔ QUASE-PAR: numa CRIAÇÃO o mesmo SKU é uma recusa da fase A.
    expect(
      motivos(
        planejarKit(contexto({ produto: { id: K, sku: 'KIT-1 ', raw: RAW_DO_KIT } }), fotos())
          .problemas,
      ),
    ).toEqual([M.kitSkuComEspacos]);
  });
});

describe('planejarKit — o veredito da busca decide o que conta (R-c)', () => {
  const ligado = vinculo('link-1', { kitNativo: true, item_id: KIT });
  const retomada = (over: Partial<ContextoKit> = {}) =>
    contexto({
      vinculos: [ligado],
      busca: busca([{ itemId: KIT, vinculo: { produtoId: K, linkDocId: 'link-1' } }]),
      ...over,
    });
  const ruim: Partial<ContextoKit> = {
    principal: null,
    principalPedido: null,
    canais: [],
    filhos: [
      filho(MEMBRO, { preco: null, componentesKit: { ...RECEITA, [X]: { quantidade: 1 } } }),
    ],
  };

  it('M181/M170 — completar: conteúdo CAI, receita vira aviso, principal NÃO é avaliado', () => {
    const plano = planejarKit(retomada(ruim), null);
    expect(plano.kitNovo).toEqual({ acao: 'completar', linkDocId: 'link-1', itemId: KIT });
    expect(plano.problemas).toEqual([]);
    expect(plano.corpo).toBeNull();
    expect(plano.avisos.filter((a) => a.codigo === 'receita-nao-publicavel')).toEqual([
      {
        codigo: 'receita-nao-publicavel',
        produtoId: MEMBRO,
        mensagem:
          `a composição da variação ${MEMBRO} no ERP não pode ir para a Shopee ` +
          `(${M.componenteNaoPublicado}: ${X}) — o kit continua com a receita atual; corrija o ` +
          'componente ou a composição no ERP',
      },
    ]);
  });

  it('⛔ QUASE-PAR de M181 — as MESMAS faltas numa criação recusam todas, o principal incluso', () => {
    const plano = planejarKit(contexto(ruim), null);
    expect(plano.kitNovo).toEqual({ acao: 'criar' });
    expect(motivos(plano.problemas)).toEqual([
      M.componenteNaoPublicado,
      M.principalObrigatorio,
      M.semPreco,
      M.logisticaSemCanal,
    ]);
    expect(plano.corpo).toBeNull();
  });

  it('recusar: a recusa da busca vem PRIMEIRO, e o principal não é avaliado', () => {
    const plano = planejarKit(
      contexto({
        principal: null,
        principalPedido: null,
        busca: busca([{ itemId: KIT_2, vinculo: null }]),
      }),
      null,
    );
    expect(plano.kitNovo?.acao).toBe('recusar');
    expect(motivos(plano.problemas)).toEqual([M.kitJaExisteNaShopee]);
    expect(plano.corpo).toBeNull();
  });

  it('sem busca numa criação (null) ⇒ nenhum kitNovo e NENHUM corpo — nunca um create sem a varredura', () => {
    const plano = planejarKit(contexto({ busca: null }), fotos());
    expect(plano.kitNovo).toBeNull();
    expect(plano.problemas).toEqual([]);
    expect(plano.corpo).toBeNull();
  });

  it('o vínculo nativo de K que a busca não listou: a leitura em lote o confirma (S2C-02)', () => {
    const plano = planejarKit(
      contexto({
        vinculos: [ligado],
        busca: buscaVazia(),
        nossosVivos: new Map([[KIT, 'UNLIST']]),
      }),
      null,
    );
    expect(plano.kitNovo).toEqual({ acao: 'completar', linkDocId: 'link-1', itemId: KIT });
  });
});

/* -------------------------------------------------------------------------- */
/*                    FX-B1: OP-8, OP-9 and the two fold scopes                */
/* -------------------------------------------------------------------------- */

describe('OP-8 — um --principal NOMEADO que não resolve recusa principal-invalido', () => {
  /** What prepararKit hands over for an unresolved name: no address, the raw id kept. */
  const naoResolvido = (id: string, over: Partial<ContextoKit> = {}): ContextoKit =>
    contexto({ principal: null, principalPedido: null, principalSolicitado: id, ...over });
  const umItem: Partial<ContextoKit> = {
    filhos: [filho(MEMBRO, { componentesKit: { [A]: { quantidade: 2 } } })],
    produto: {
      id: K,
      sku: 'KIT-1',
      raw: { ...RAW_DO_KIT, componentesKit: { [A]: { quantidade: 2 } } },
    },
  };

  it('UM item: nunca o padrão silencioso — recusa nomeando o id, sem corpo', () => {
    const plano = planejarKit(naoResolvido('fantasma', umItem), fotos());
    expect(plano.problemas).toEqual([
      {
        campo: 'principal',
        motivo: M.principalInvalido,
        mensagem: 'o componente principal fantasma não faz parte da composição do kit',
      },
    ]);
    expect(plano.corpo).toBeNull();
    // ⛔ QUASE-PAR: o MESMO kit sem --principal algum segue com o padrão (M96).
    const semNome = planejarKit(
      contexto({ principal: null, principalPedido: null, principalSolicitado: null, ...umItem }),
      fotos(),
    );
    expect(semNome.problemas).toEqual([]);
    expect(semNome.principal).toEqual(ENDERECO_A);
  });

  it('DOIS itens: principal-invalido, nunca principal-obrigatorio (o operador JÁ informou um)', () => {
    const plano = planejarKit(naoResolvido('fantasma'), fotos());
    expect(motivos(plano.problemas)).toEqual([M.principalInvalido]);
    expect(plano.corpo).toBeNull();
  });

  it('um componente DA receita que não resolveu: a frase diz que ele não tem anúncio utilizável', () => {
    const plano = planejarKit(
      naoResolvido(A, {
        resolucao: resolucao([[A, { ok: false, motivo: 'componente-nao-publicado' }]]),
      }),
      fotos(),
    );
    expect(plano.problemas.filter((p) => p.campo === 'principal')).toEqual([
      {
        campo: 'principal',
        motivo: M.principalInvalido,
        mensagem:
          `o componente principal ${A} não tem anúncio utilizável nesta conta Shopee — corrija o ` +
          'componente ou informe outro (--principal)',
      },
    ]);
  });

  it('⛔ QUASE-PAR: um nome que RESOLVE não é recusado aqui (escolherPrincipalDoKit o julga)', () => {
    const plano = planejarKit(contexto({ principalSolicitado: A }), fotos());
    expect(plano.problemas).toEqual([]);
    expect(plano.principal).toEqual(ENDERECO_A);
  });

  it('também numa retomada (completar) — o recriar compara o principal; e nunca numa republicação', () => {
    const ligado = vinculo('link-1', { kitNativo: true, item_id: KIT });
    const retomada = planejarKit(
      naoResolvido('fantasma', {
        vinculos: [ligado],
        busca: busca([{ itemId: KIT, vinculo: { produtoId: K, linkDocId: 'link-1' } }]),
      }),
      null,
    );
    expect(retomada.kitNovo?.acao).toBe('completar');
    expect(motivos(retomada.problemas)).toEqual([M.principalInvalido]);

    const republicacao = planejarKit(atualizar({ principalSolicitado: 'fantasma' }), fotos());
    expect(motivos(republicacao.problemas)).not.toContain(M.principalInvalido);
  });
});

describe('OP-9 — --status UNLIST numa criação manda unlisted: true; NORMAL não manda a chave', () => {
  it('UNLIST ⇒ unlisted: true, aceito pelo guarda do PACOTE', () => {
    const corpo = planejarKit(contexto({ statusPedido: 'UNLIST' }), fotos()).corpo;
    expect(corpo).not.toBeNull();
    if (corpo === null) return;
    expect(corpo.item_setting.unlisted).toBe(true);
    expect(() => assertAddKitItemRequest(corpo)).not.toThrow();
  });

  it('⛔ QUASE-PAR: NORMAL, ou status ausente ⇒ nenhuma chave unlisted (o corpo que as sondas mediram)', () => {
    for (const ctx of [contexto({ statusPedido: 'NORMAL' }), contexto()]) {
      const corpo = planejarKit(ctx, fotos()).corpo;
      expect(corpo).not.toBeNull();
      expect('unlisted' in (corpo?.item_setting ?? { unlisted: 'ausente' })).toBe(false);
    }
  });
});

/** A stored `componentesKit` as Firestore holds it — unparsed (an entry may lack `quantidade`). */
type Armazenado = NonNullable<FilhoDoKit['componentesKitArmazenado']>;

describe('o escopo das dobras (R2-F1, R1-RT7-02)', () => {
  it('opcaoDoTierKit: aparada e com a caixa — par IGUAL e quase-par DISTINTO', () => {
    expect(opcaoDoTierKit(' Azul ')).toBe(opcaoDoTierKit('Azul'));
    expect(opcaoDoTierKit('azul')).not.toBe(opcaoDoTierKit('Azul'));
    expect(opcaoDoTierKit('   ')).toBeNull();
    expect(opcaoDoTierKit(null)).toBeNull();
  });

  it('a impressão gravada é a do mapa ARMAZENADO: sem quantidade ≢ quantidade 1 (o que os leitores dobram)', () => {
    const parseado = { [A]: { quantidade: 1 } };
    const armazenado: Armazenado = { [A]: { limitarEstoque: true } };
    expect(chaveReceitaArmazenadaDoFilho(filho(MEMBRO, { componentesKit: parseado }))).toBe(
      chaveReceitaKitErp(parseado),
    );
    const comArmazenado = filho(MEMBRO, {
      componentesKit: parseado,
      componentesKitArmazenado: armazenado,
    });
    expect(chaveReceitaArmazenadaDoFilho(comArmazenado)).toBe(chaveReceitaKitErp(armazenado));
    expect(chaveReceitaArmazenadaDoFilho(comArmazenado)).not.toBe(chaveReceitaKitErp(parseado));
    // A stored map that is not a map reads null, never the parse.
    expect(chaveReceitaArmazenadaDoFilho(filho(MEMBRO, { componentesKitArmazenado: null }))).toBe(
      chaveReceitaKitErp(null),
    );
  });

  it('M94 (escopo armazenado) — K e o membro guardados SEM quantidade são o MESMO espelho; quantidade 2 em K diverge', () => {
    const guardado: Armazenado = { [A]: { limitarEstoque: true }, [B]: { quantidade: 2 } };
    const membro = filho(MEMBRO, {
      componentesKit: { [A]: { quantidade: 1 }, [B]: { quantidade: 2 } },
      componentesKitArmazenado: guardado,
    });
    const igual = planejarKit(
      contexto({
        filhos: [membro],
        produto: { id: K, sku: 'KIT-1', raw: { ...RAW_DO_KIT, componentesKit: guardado } },
      }),
      fotos(),
    );
    expect(igual.avisos.map((a) => a.codigo)).not.toContain('receita-espelho-divergente');
    const diverge = planejarKit(
      contexto({
        filhos: [membro],
        produto: {
          id: K,
          sku: 'KIT-1',
          raw: { ...RAW_DO_KIT, componentesKit: { ...guardado, [A]: { quantidade: 2 } } },
        },
      }),
      fotos(),
    );
    expect(diverge.avisos.map((a) => a.codigo)).toContain('receita-espelho-divergente');
  });

  it('situacaoDoSkuDoKit (R2-F3): o SKU é um ponto fixo da dobra do degrau 2 — pares IGUAIS e quase-pares DISTINTOS', () => {
    expect(situacaoDoSkuDoKit('KIT-1')).toBe('ok');
    for (const vazio of [null, '', '   ']) expect(situacaoDoSkuDoKit(vazio)).toBe('sem-sku');
    expect(situacaoDoSkuDoKit(' KIT-1')).toBe('com-espacos');
    expect(situacaoDoSkuDoKit('KIT-1 ')).toBe('com-espacos');
    // ⛔ QUASE-PARES: a dobra real para nas PONTAS e não mexe na caixa.
    expect(situacaoDoSkuDoKit('KIT  1')).toBe('ok');
    expect(situacaoDoSkuDoKit('kit-1')).toBe('ok');
  });

  it('(R2-F3) cada guarda de SKU PERGUNTA à dobra do degrau 2: alargada (espaços internos), a fase A recusa, a republicação avisa e o corpo não manda o SKU', () => {
    const duplo = { id: K, sku: 'KIT  1', raw: RAW_DO_KIT };
    // A dobra real: o espaço interno é parte do SKU, nada recusa.
    expect(problemasDaFaseA(faseA({ produto: duplo }))).toEqual([]);
    expect(planejarKit(atualizar({ produto: duplo }), fotos()).sku).toBe('KIT  1');

    dobraDoImport.larga = true;
    // A busca e a importação lêem 'KIT 1' — o ERP não acharia K por 'KIT  1'.
    expect(situacaoDoSkuDoKit('KIT  1')).toBe('com-espacos');
    expect(motivos(problemasDaFaseA(faseA({ produto: duplo })))).toEqual([M.kitSkuComEspacos]);
    const republicacao = planejarKit(atualizar({ produto: duplo }), fotos());
    expect(republicacao.sku).toBeNull();
    expect(republicacao.avisos.map((a) => a.codigo)).toEqual(['sku-do-kit-nao-enviado']);
    // ⛔ QUASE-PAR: um SKU que a dobra larga também deixa igual segue passando.
    expect(problemasDaFaseA(faseA())).toEqual([]);
  });
});

describe('tetoDeFotosDoKit (OP-10) — UMA regra para o upload e para a capa', () => {
  it('o máximo servido quando menor que 9; 9 quando não servido, ausente, 0 ou maior', () => {
    const banda = (bandas: Record<string, unknown>) =>
      shopeeKitItemLimitPayloadSchema.parse(bandas);
    expect(
      tetoDeFotosDoKit(banda({ item_image_count_limit: { min_limit: 1, max_limit: 5 } })),
    ).toBe(5);
    expect(tetoDeFotosDoKit(null)).toBe(CAP_FOTOS_KIT);
    expect(tetoDeFotosDoKit(banda({}))).toBe(CAP_FOTOS_KIT);
    expect(
      tetoDeFotosDoKit(banda({ item_image_count_limit: { min_limit: 0, max_limit: 0 } })),
    ).toBe(CAP_FOTOS_KIT);
    expect(
      tetoDeFotosDoKit(banda({ item_image_count_limit: { min_limit: 1, max_limit: 12 } })),
    ).toBe(CAP_FOTOS_KIT);
  });

  it('a capa do plano corta pelo MESMO teto (0 servido ⇒ 9, nunca zero fotos)', () => {
    const doze = Array.from({ length: 12 }, (_, i) => `img-${String(i)}`);
    const zero = planejarKit(
      contexto({ limites: servidos({ item_image_count_limit: { min_limit: 0, max_limit: 0 } }) }),
      fotos(doze),
    );
    expect(zero.corpo?.item_setting.images.image_id_list).toEqual(doze.slice(0, CAP_FOTOS_KIT));
  });
});
