import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHOPEE_ERROR_KIND, ShopeeApiError, ShopeeError } from '@delfrance/integrations-shopee';

import { erroContidoPorConta } from '../core/containment';
// ⚠️ `respond.ts` imports `next/server` and is therefore NOT Next-free — which is
// exactly why no MODULE under `anuncios/` may import it (the Cloud Functions
// bundle reaches this folder through the link trigger). A TEST may: it never
// reaches that bundle, and the property under test is precisely that the two
// sides agree about these two classes.
import { isShopeeError } from '../core/respond';
import * as constantes from './constantesAnuncio';
import {
  ETAPA_PUBLICACAO,
  MOTIVO_PROBLEMA_PUBLICACAO,
  MOTIVO_PUBLICACAO_BLOQUEADA,
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
  cabecalhoDaRecusa,
  limitarMensagemProblema,
  temProblemaDeBloqueio,
  type ProblemaDeBloqueio,
  type ProblemaPublicacao,
} from './errosPublicacao';
import { MOTIVO_TAX_INFO_OMITIDO } from './taxInfoPublicacao';

const PRODUTO_ID = 'prod-fixture-1';
const ITEM_ID = 2500139861;
const MAX_MENSAGEM_PROBLEMA = constantes.MAX_MENSAGEM_PROBLEMA;

function problemaDeBloqueio(
  motivo: ProblemaDeBloqueio['motivo'],
  campo: string | null = null,
  mensagem = 'mecanismo',
): ProblemaDeBloqueio {
  return { campo, motivo, mensagem };
}

function bloqueado(
  problemas: readonly [ProblemaDeBloqueio, ...ProblemaDeBloqueio[]] = [
    problemaDeBloqueio(MOTIVO_PUBLICACAO_BLOQUEADA.semPeso, 'weight'),
  ],
  itemId: number | null = null,
) {
  return new ShopeePublishBlockedError({ produtoId: PRODUTO_ID, itemId, problemas });
}

function recusado(
  problemas: readonly ProblemaPublicacao[] = [],
  shopeeCode = 'product.error_param',
) {
  return new ShopeePublishRejectedError({
    etapa: ETAPA_PUBLICACAO.addItem,
    shopeeCode,
    produtoId: PRODUTO_ID,
    itemId: null,
    problemas,
  });
}

describe('MOTIVO_PUBLICACAO_BLOQUEADA', () => {
  it('1 — o vocabulário bloqueado é EXATAMENTE estes vinte e dois slugs', () => {
    // A PERSISTED vocabulary (`falhaPublicacao.motivo` e
    // `falhaPublicacao.problemas[].motivo`). Esta lista É o pino: o
    // `as const satisfies` garante o TIPO dos valores, mas não impede que um
    // membro seja renomeado nos DOIS lugares de uma vez — que é exatamente o
    // refactor silencioso que órfã toda linha já escrita. A igualdade de
    // conjunto contra literais é o que fica vermelho aí.
    // ⚠️ `produto-e-kit` teve o PREDICADO estreitado no passo 12 (#1520) — hoje
    // ele é o kit NATIVO da Shopee (`kitNativo` no vínculo, `ehKitVirtual` na
    // primeira publicação), nunca o `ehKit` do ERP. O SLUG não mudou, e é por
    // isso que as recusas já gravadas continuam legíveis.
    expect([...Object.values(MOTIVO_PUBLICACAO_BLOQUEADA)].sort()).toEqual([
      'atributo-obrigatorio',
      'categoria-invalida',
      'combinacao-duplicada',
      'descricao-fora-da-faixa',
      'estoque-abaixo-do-minimo',
      'filho-sem-preco',
      'listagem-removida',
      'logistica-sem-canal',
      'marca-sem-nome',
      'nome-fora-da-faixa',
      'opcoes-demais',
      'preco-fora-da-faixa',
      'produto-e-filho',
      'produto-e-kit',
      'sem-descricao',
      'sem-dimensoes',
      'sem-fotos',
      'sem-gtin',
      'sem-nome',
      'sem-peso',
      'sem-preco',
      'variacao-sem-vinculo',
    ]);
    expect(Object.values(MOTIVO_PUBLICACAO_BLOQUEADA)).toHaveLength(22);
  });

  it('2 — ⛔ NEAR-MISS: `imposto-incompleto` NÃO é membro, e `estoque-abaixo-do-minimo` É', () => {
    // As duas metades da mesma regra — um membro só existe se algo o produz.
    //
    // `imposto-incompleto` saiu porque Lucas escolheu o braço OMITIR (Q2): um
    // bloco `tax_info` incompleto é deixado FORA do corpo e registrado em
    // `taxInfoOmitido`, então nada consegue recusar uma publicação por ele.
    // `estoque-abaixo-do-minimo` entrou pelo caminho oposto: a sandbox recusou
    // um create com estoque abaixo do `stock_limit.min_limit` da loja, então há
    // um produtor real (a montagem) para ele.
    const valores: readonly string[] = Object.values(MOTIVO_PUBLICACAO_BLOQUEADA);
    expect(valores).not.toContain('imposto-incompleto');
    expect(valores).toContain('estoque-abaixo-do-minimo');

    const doProblema: readonly string[] = Object.values(MOTIVO_PROBLEMA_PUBLICACAO);
    expect(doProblema).not.toContain('imposto-incompleto');
  });

  it('3 — todo slug é kebab-case ASCII minúsculo', () => {
    // O slug viaja em JSON, vira chave de agrupamento e aparece numa URL de
    // filtro: acento, espaço, maiúscula e `_` estão todos fora.
    for (const slug of Object.values(MOTIVO_PROBLEMA_PUBLICACAO)) {
      expect(slug, slug).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    }
  });

  it('4 — as CHAVES do const casam com os slugs em camelCase', () => {
    // O `as const satisfies` já garante o TIPO dos valores; isto garante que a
    // chave que o código escreve (`MOTIVO_PUBLICACAO_BLOQUEADA.semPeso`) e o
    // slug que o Firestore guarda (`sem-peso`) não possam divergir em silêncio.
    for (const [chave, slug] of Object.entries(MOTIVO_PROBLEMA_PUBLICACAO)) {
      const emCamel = slug.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      expect(chave, slug).toBe(emCamel);
    }
  });
});

describe('MOTIVO_PROBLEMA_PUBLICACAO', () => {
  it('5 — o vocabulário de problema é o bloqueado MAIS exatamente doze slugs de wire', () => {
    // O passo 18 acrescentou os dois de `size_chart_info`: o modelo que a Shopee
    // recusou e a foto da tabela que ela recusou (ou cujo upload falhou). O passo
    // 19 acrescentou as sete recusas de KIT NATIVO, cujo único produtor é
    // `kits/recusaKit.ts` (`preco-fora-da-faixa`, a oitava linha daquela tabela,
    // já era membro BLOQUEADO).
    expect([...Object.values(MOTIVO_PROBLEMA_PUBLICACAO)].sort()).toEqual(
      [
        ...Object.values(MOTIVO_PUBLICACAO_BLOQUEADA),
        'bloqueado-por-promocao',
        'imposto-recusado',
        'tabela-de-medidas-recusada',
        'tabela-de-medidas-foto-recusada',
        'operacao-invalida-para-kit',
        'instabilidade-shopee',
        'imagem-de-kit-desligada',
        'kit-inexistente',
        'kit-bloqueado-pela-shopee',
        'faixa-de-componentes',
        'kit-principal-duplicado',
        'desconhecido',
      ].sort(),
    );
    expect(Object.values(MOTIVO_PROBLEMA_PUBLICACAO)).toHaveLength(34);
  });

  it('6 — ⛔ NEAR-MISS: os doze slugs de WIRE não pertencem ao vocabulário BLOQUEADO', () => {
    // O publisher nunca RECUSA por um deles: nenhum é uma decisão tomada lendo
    // o produto. Se escorregassem para o conjunto bloqueado, um
    // `ShopeePublishBlockedError` passaria a poder dizer "bloqueado por
    // promoção" sem que uma única chamada tivesse sido feita.
    // ⚠️ Os dois da tabela de medidas idem: um `avisoObrigatoria` é um AVISO
    // (nunca um bloqueio), e o BLOQUEADO continua com 22 membros.
    // ⚠️ E os sete de KIT (passo 19) também: cada um é uma frase da Shopee
    // classificada DEPOIS de uma escrita, nunca algo lido no produto.
    const bloqueados: readonly string[] = Object.values(MOTIVO_PUBLICACAO_BLOQUEADA);
    expect(bloqueados).not.toContain('bloqueado-por-promocao');
    expect(bloqueados).not.toContain('imposto-recusado');
    expect(bloqueados).not.toContain('tabela-de-medidas-recusada');
    expect(bloqueados).not.toContain('tabela-de-medidas-foto-recusada');
    expect(bloqueados).not.toContain('desconhecido');
    for (const slug of [
      'operacao-invalida-para-kit',
      'instabilidade-shopee',
      'imagem-de-kit-desligada',
      'kit-inexistente',
      'kit-bloqueado-pela-shopee',
      'faixa-de-componentes',
      'kit-principal-duplicado',
    ]) {
      expect(bloqueados, slug).not.toContain(slug);
    }
    expect(bloqueados).toHaveLength(22);
  });
});

describe('ETAPA_PUBLICACAO', () => {
  it('7 — as etapas são EXATAMENTE estas dez, na grafia da ordem do `aplicar`', () => {
    // Também PERSISTIDA (`falhaPublicacao.etapa`), e a única coisa que responde
    // "o que existe no canal agora". As sete primeiras são nomes de operação da
    // Shopee em `snake_case` porque é assim que o log e a doc as chamam; as três
    // últimas são passos nossos e ficam em pt-BR.
    expect([...Object.values(ETAPA_PUBLICACAO)]).toEqual([
      'fotos',
      'add_item',
      'update_item',
      'init_tier_variation',
      'update_tier_variation',
      'add_model',
      'update_model',
      'get_model_list',
      'relistagem',
      'leitura-de-volta',
    ]);
  });
});

describe('limitarMensagemProblema', () => {
  it('8 — PAR: uma mensagem de 500 caracteres passa INTACTA', () => {
    const noLimite = 'a'.repeat(MAX_MENSAGEM_PROBLEMA);
    expect(limitarMensagemProblema(noLimite)).toBe(noLimite);
    expect(limitarMensagemProblema(noLimite)).toHaveLength(MAX_MENSAGEM_PROBLEMA);
    expect(limitarMensagemProblema('')).toBe('');
  });

  it('9 — ⛔ NEAR-MISS: uma de 501 é CORTADA, e o resultado nunca passa do teto', () => {
    // O par que dá sentido ao teste 8. Um corte em 501 (ou um `…` acrescentado
    // DEPOIS do fatiamento, como faz o `safeJson` do respond.ts) devolveria 501
    // caracteres — e o teto deixaria de ser um teto justo onde o documento do
    // link guarda o valor.
    const umAMais = 'a'.repeat(MAX_MENSAGEM_PROBLEMA + 1);
    const cortada = limitarMensagemProblema(umAMais);

    expect(cortada).not.toBe(umAMais);
    expect(cortada).toHaveLength(MAX_MENSAGEM_PROBLEMA);
    expect(cortada.endsWith('…')).toBe(true);
    expect(cortada.slice(0, MAX_MENSAGEM_PROBLEMA - 1)).toBe(
      umAMais.slice(0, MAX_MENSAGEM_PROBLEMA - 1),
    );
  });

  it('10 — o teto vale por CONSTRUÇÃO nas duas classes, não por lembrança do produtor', () => {
    // O ponto inteiro de normalizar no construtor: um produtor que esqueça o
    // corte não consegue persistir uma prosa de 4 KB da Shopee em
    // `falhaPublicacao.problemas[]` nem devolvê-la num corpo 422.
    const enorme = 'x'.repeat(4096);

    const bloq = bloqueado([problemaDeBloqueio(MOTIVO_PUBLICACAO_BLOQUEADA.semNome, null, enorme)]);
    expect(bloq.problemas[0]?.mensagem).toHaveLength(MAX_MENSAGEM_PROBLEMA);

    const rej = recusado([{ campo: null, motivo: 'desconhecido', mensagem: enorme }]);
    expect(rej.problemas[0]?.mensagem).toHaveLength(MAX_MENSAGEM_PROBLEMA);

    // ⛔ NEAR-MISS: o `campo` e o `motivo` atravessam INTACTOS — a normalização
    // toca uma chave só.
    expect(rej.problemas[0]?.motivo).toBe('desconhecido');
    expect(bloq.problemas[0]?.campo).toBeNull();
  });
});

describe('ShopeePublishBlockedError', () => {
  it('11 — é um ShopeeError e um Error, e se anuncia pelo `name`', () => {
    const err = bloqueado();
    expect(err).toBeInstanceOf(ShopeeError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ShopeePublishBlockedError');
  });

  it('12 — o `motivo` é o do PRIMEIRO problema, nunca o do último', () => {
    // Os produtores acrescentam na ordem em que checam, então o primeiro é o
    // que o leitor deve ver. Pegar o último reportaria como causa a checagem que
    // por acaso rodou por último — e os dois passam por qualquer teste que só
    // pergunte "o motivo é um membro do vocabulário?".
    const err = bloqueado([
      problemaDeBloqueio(MOTIVO_PUBLICACAO_BLOQUEADA.semPeso, 'weight'),
      problemaDeBloqueio(MOTIVO_PUBLICACAO_BLOQUEADA.semDimensoes, 'dimension'),
      problemaDeBloqueio(MOTIVO_PUBLICACAO_BLOQUEADA.semGtin, 'gtin_code'),
    ]);

    expect(err.motivo).toBe('sem-peso');
    expect(err.motivo).not.toBe('sem-gtin');
    expect(err.message).toContain('sem-peso');
    expect(err.message).not.toContain('sem-gtin');
  });

  it('13 — `itemId` é null numa PRIMEIRA publicação e `produtoId` nunca é vazio', () => {
    // A diferença inteira entre as duas direções: importar sempre tem um
    // `item_id`, publicar pela primeira vez não tem nenhum. Por isso a classe se
    // identifica pelo `produtoId`.
    const primeira = bloqueado();
    expect(primeira.itemId).toBeNull();
    expect(primeira.produtoId).toBe(PRODUTO_ID);
    expect(primeira.message).toBe(
      'Publicação bloqueada (sem-peso) no produto prod-fixture-1: 1 problema',
    );

    const republicacao = bloqueado(
      [
        problemaDeBloqueio(MOTIVO_PUBLICACAO_BLOQUEADA.listagemRemovida),
        problemaDeBloqueio(MOTIVO_PUBLICACAO_BLOQUEADA.semFotos),
      ],
      ITEM_ID,
    );
    expect(republicacao.itemId).toBe(ITEM_ID);
    expect(republicacao.message).toBe(
      'Publicação bloqueada (listagem-removida) no produto prod-fixture-1 (item 2500139861): 2 problemas',
    );
  });

  it('14 — a `message` não carrega a prosa de NENHUM problema', () => {
    // #1015. A mensagem vai para o log (`logErrorResponse` imprime `err.message`)
    // e para o corpo 422. `problemas[].mensagem` pode conter a prosa da própria
    // Shopee quando o classificador não soube nomear um campo — e essa prosa não
    // pode vazar para uma linha de log por tabela.
    const err = bloqueado([
      problemaDeBloqueio(
        MOTIVO_PUBLICACAO_BLOQUEADA.atributoObrigatorio,
        'attribute_list',
        'PROSA-DA-SHOPEE-QUE-NAO-PODE-VAZAR',
      ),
    ]);
    expect(err.message).not.toContain('PROSA-DA-SHOPEE-QUE-NAO-PODE-VAZAR');
    expect(err.problemas[0]?.mensagem).toBe('PROSA-DA-SHOPEE-QUE-NAO-PODE-VAZAR');
  });

  it('15 — ⛔ NEAR-MISS: NÃO é contida por conta, embora estenda ShopeeError', () => {
    // A célula decisiva, e ela vale MAIS aqui que na importação: uma publicação
    // em massa (passo futuro) tem de conter a recusa POR PRODUTO, não deixar um
    // produto bloqueado abortar o tick da conta inteira. `erroContidoPorConta`
    // nomeia CLASSES e nunca a base, então herdar de `ShopeeError` não muda isso
    // — e se alguém trocar a lista por um `instanceof ShopeeError`, é aqui que
    // fica vermelho.
    expect(bloqueado()).toBeInstanceOf(ShopeeError);
    expect(recusado()).toBeInstanceOf(ShopeeError);
    expect(erroContidoPorConta(bloqueado())).toBe(false);
    expect(erroContidoPorConta(recusado())).toBe(false);

    // ⛔ O par que dá sentido: uma classe que ESTÁ na lista continua contida, de
    // propósito. Sem esta linha as duas asserções acima passariam mesmo com a
    // contenção desligada para todo mundo.
    expect(
      erroContidoPorConta(
        new ShopeeApiError('recusou', {
          code: 'product.error_param',
          kind: SHOPEE_ERROR_KIND.other,
          httpStatus: 200,
          path: '/api/v2/product/add_item',
        }),
      ),
    ).toBe(true);
  });

  it('16 — as duas classes são reconhecidas por `isShopeeError`, para o braço 422', () => {
    // O catch da rota rethrowa tudo que a guarda recusar (regra 6), então sem
    // isto um produto bloqueado viraria 500 em vez de 422.
    expect(isShopeeError(bloqueado())).toBe(true);
    expect(isShopeeError(recusado())).toBe(true);
  });

  it('17 — `temProblemaDeBloqueio` é o que transforma a lista coletada no argumento', () => {
    // A guarda existe porque o `motivo` É o do primeiro problema: uma lista
    // vazia não teria resposta, e inventar um membro de fallback seria criar um
    // slug que nada legítimo produz.
    const vazia: readonly ProblemaDeBloqueio[] = [];
    expect(temProblemaDeBloqueio(vazia)).toBe(false);

    const coletada: readonly ProblemaDeBloqueio[] = [
      problemaDeBloqueio(MOTIVO_PUBLICACAO_BLOQUEADA.produtoEKit),
    ];
    expect(temProblemaDeBloqueio(coletada)).toBe(true);
    if (temProblemaDeBloqueio(coletada)) {
      expect(
        new ShopeePublishBlockedError({ produtoId: PRODUTO_ID, itemId: null, problemas: coletada })
          .motivo,
      ).toBe('produto-e-kit');
    }
  });
});

describe('ShopeePublishRejectedError', () => {
  it('18 — é um ShopeeError, carrega a etapa e se anuncia pelo `name`', () => {
    const err = new ShopeePublishRejectedError({
      etapa: ETAPA_PUBLICACAO.initTierVariation,
      shopeeCode: 'product.error_param',
      produtoId: PRODUTO_ID,
      itemId: ITEM_ID,
      problemas: [{ campo: 'tier_variation', motivo: 'opcoes-demais', mensagem: 'mecanismo' }],
    });

    expect(err).toBeInstanceOf(ShopeeError);
    expect(err.name).toBe('ShopeePublishRejectedError');
    expect(err.etapa).toBe('init_tier_variation');
    expect(err.itemId).toBe(ITEM_ID);
    expect(err.message).toBe(
      'Publicação recusada pela Shopee em init_tier_variation (product.error_param) ' +
        'no produto prod-fixture-1 (item 2500139861): 1 problema',
    );
  });

  it('19 — o `shopeeCode` fica VERBATIM: o prefixo de módulo sobrevive', () => {
    // O `product.` é real no fio (a sandbox devolveu `product.error_param` em
    // 2026-09-17). A forma sem prefixo existe só para CLASSIFICAR; guardá-la
    // aqui jogaria fora qual módulo recusou — e dois módulos usam o mesmo
    // sufixo, então o prefixo é a única coisa que diz qual lista de erros ler.
    expect(recusado([], 'product.error_param').shopeeCode).toBe('product.error_param');
    expect(recusado([], 'error_param').shopeeCode).toBe('error_param');
    expect(recusado([], 'product.error_param').shopeeCode).not.toBe('error_param');
  });

  it('20 — uma lista de problemas VAZIA é legítima aqui (e impossível na gêmea)', () => {
    // Uma recusa de fio que o classificador não soube atribuir a campo nenhum
    // ainda precisa chegar com a etapa e o código. Inventar uma entrada
    // `desconhecido` só para encher a lista colocaria prosa do provedor onde o
    // leitor espera um mecanismo. A gêmea pré-escrita é o contrário: sem pelo
    // menos um problema ela não teria `motivo`, e o TIPO do argumento
    // (`readonly [ProblemaDeBloqueio, ...]`) recusa a lista vazia em compilação.
    const err = recusado([]);
    expect(err.problemas).toEqual([]);
    expect(err.message).toContain('0 problemas');
  });

  it('20b — sem código da Shopee, o cabeçalho NÃO leva um "()" vazio (passo 18: a foto da tabela)', () => {
    const semCodigo = new ShopeePublishRejectedError({
      etapa: ETAPA_PUBLICACAO.fotos,
      shopeeCode: '',
      produtoId: PRODUTO_ID,
      itemId: null,
      problemas: [],
    });
    expect(semCodigo.message).toBe(
      'Publicação recusada pela Shopee em fotos no produto prod-fixture-1: 0 problemas',
    );
    expect(semCodigo.message).not.toContain('()');
    // O padrão é "a Shopee recusou" — todo produtor fora a foto da tabela.
    expect(semCodigo.recusadaPelaShopee).toBe(true);
    // ⚠️ QUASE-PAR: com código, os parênteses voltam — verbatim.
    expect(recusado([], 'product.error_busi').message).toContain(
      'em add_item (product.error_busi) ',
    );
  });

  it('20c — uma foto que a Shopee NUNCA viu: "interrompida", nunca "recusada pela Shopee"', () => {
    const err = new ShopeePublishRejectedError({
      etapa: ETAPA_PUBLICACAO.fotos,
      shopeeCode: '',
      produtoId: PRODUTO_ID,
      itemId: ITEM_ID,
      problemas: [
        {
          campo: 'size_chart_info',
          motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasFotoRecusada,
          mensagem: 'mecanismo',
        },
      ],
      recusadaPelaShopee: false,
    });
    expect(err.recusadaPelaShopee).toBe(false);
    expect(err.message).toBe(
      'Publicação interrompida em fotos no produto prod-fixture-1 (item 2500139861): 1 problema',
    );
    expect(err.message).not.toContain('Shopee');
    // A CLI e a classe dizem a MESMA coisa: uma função só.
    expect(cabecalhoDaRecusa(err.etapa, err.shopeeCode, err.recusadaPelaShopee)).toBe(
      'Publicação interrompida em fotos',
    );
    expect(cabecalhoDaRecusa(ETAPA_PUBLICACAO.addItem, 'product.error_param', true)).toBe(
      'Publicação recusada pela Shopee em add_item (product.error_param)',
    );
  });
});

describe('constantesAnuncio', () => {
  it('21 — o módulo exporta EXATAMENTE as dez constantes que o wire não enuncia', () => {
    expect(Object.keys(constantes).sort()).toEqual([
      'CANAL_SEM_PRE_ORDER',
      'ESPERA_APOS_ADD_ITEM_MS',
      'FRASE_TAX_INFO_INCOMPLETO',
      'MAX_MENSAGEM_PROBLEMA',
      'MAX_PAGINAS_MARCAS',
      'MEASURE_UNIT_SHOPEE',
      'POLITICA_TAX_INFO',
      'RELIST_PRIMEIRO',
      'SEM_CEST_SHOPEE',
      'SEM_NCM_SHOPEE',
    ]);
  });

  it('22 — ⛔ NENHUMA constante `SHOPEE_*`: todo limite do FIO mora no pacote', () => {
    // A propriedade medida no TEXTO, porque o que se quer pegar é uma cópia
    // local de um limite documentado — e uma cópia compila, passa nos testes e
    // só diverge meses depois. A sonda mediu `SHOPEE_TIER_MAX_OPTIONS` em 50
    // (as páginas trazem 20 E 50) e virou UM literal no pacote; uma cópia aqui
    // teria mantido o 20 vivo com um comentário dizendo que os dois concordam.
    const fonte = readFileSync(
      fileURLToPath(new URL('./constantesAnuncio.ts', import.meta.url)),
      'utf8',
    );
    expect(fonte.includes('export const SHOPEE_')).toBe(false);
  });

  it('23 — RELIST_PRIMEIRO é `unlist`, e o tipo continua largo o bastante para o fallback', () => {
    // A anotação de união é carregada: estreitar para `'unlist'` faria o TS
    // podar o braço de fallback como código morto — e o fallback
    // (`update_item {item_status: NORMAL}`) é justamente o caminho NÃO medido,
    // o do UNLIST pré-lançamento da própria Shopee.
    expect(constantes.RELIST_PRIMEIRO).toBe('unlist');
    // A asserção de LARGURA, e ela é de compilação: estreitar a anotação para
    // `'unlist'` faz esta linha falhar no `tsc`, não aqui.
    const fallback: typeof constantes.RELIST_PRIMEIRO = 'update_item';
    expect(fallback).toBe('update_item');
    expect(constantes.ESPERA_APOS_ADD_ITEM_MS).toBe(5_000);
    expect(constantes.MEASURE_UNIT_SHOPEE).toBe('UN');
    expect(constantes.FRASE_TAX_INFO_INCOMPLETO).toBe(
      'all BR tax field should be empty or be filled at same time',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  O7 — todo membro do vocabulário tem um PRODUTOR                            */
/* -------------------------------------------------------------------------- */

/**
 * A lição do `kit-nao-importado` mecanizada: um motivo declarado que ninguém
 * produz é uma promessa que a UI renderiza e o código nunca cumpre — e ele
 * compila, passa em todo teste de pareamento chave↔slug e só aparece quando um
 * operador pergunta por que aquele veredicto nunca sai.
 *
 * O universo lido é TEXTO CRU: todo `*.ts` não-teste desta pasta, todo `*.ts`
 * não-teste de `../kits/` (passo 19: o classificador de recusas de kit, e depois
 * o núcleo do kit, produzem membros destes vocabulários de LÁ — sem esta pasta
 * o teste ficaria vermelho por um membro que tem produtor, ou, pior, verde só
 * porque outra menção o cobria) mais os três roteiros da etapa 11. Texto cru
 * porque o que se quer pegar é um membro sem nenhuma menção — um `import` não o
 * mostraria, e uma checagem de tipo menos ainda.
 */
const RAIZ_ANUNCIOS = new URL('./', import.meta.url);
const RAIZ_KITS = new URL('../kits/', import.meta.url);

const ROTAS_DA_ETAPA_11 = [
  '../../../app/api/marketplace/shopee/publicar/route.ts',
  '../../../app/api/marketplace/shopee/anuncio-status/route.ts',
  '../../../app/api/marketplace/shopee/reverificar-anuncio/route.ts',
] as const;

/** As fontes de `../kits/`, chaveadas por `../kits/<nome>` — nunca pelo nome nu. */
function fontesDosKits(): Map<string, string> {
  const fontes = new Map<string, string>();
  for (const nome of readdirSync(RAIZ_KITS)) {
    if (!nome.endsWith('.ts') || nome.endsWith('.test.ts')) continue;
    fontes.set(`../kits/${nome}`, readFileSync(new URL(nome, RAIZ_KITS), 'utf8'));
  }
  return fontes;
}

function fontesQuePodemProduzir(excluir: readonly string[]): Map<string, string> {
  const fontes = new Map<string, string>();
  for (const nome of readdirSync(RAIZ_ANUNCIOS)) {
    if (!nome.endsWith('.ts') || nome.endsWith('.test.ts')) continue;
    if (excluir.includes(nome)) continue;
    fontes.set(nome, readFileSync(new URL(nome, RAIZ_ANUNCIOS), 'utf8'));
  }
  for (const [chave, fonte] of fontesDosKits()) {
    if (excluir.includes(chave)) continue;
    fontes.set(chave, fonte);
  }
  for (const rel of ROTAS_DA_ETAPA_11) {
    fontes.set(rel, readFileSync(new URL(rel, RAIZ_ANUNCIOS), 'utf8'));
  }
  return fontes;
}

/**
 * As sete recusas de KIT NATIVO (passo 19) — chaves de
 * `MOTIVO_PROBLEMA_PUBLICACAO`, cujo único produtor é `kits/recusaKit.ts`.
 */
const CHAVES_DAS_RECUSAS_DE_KIT = [
  'operacaoInvalidaParaKit',
  'instabilidadeShopee',
  'imagemDeKitDesligada',
  'kitInexistente',
  'kitBloqueadoPelaShopee',
  'faixaDeComponentes',
  'kitPrincipalDuplicado',
] as const satisfies readonly (keyof typeof MOTIVO_PROBLEMA_PUBLICACAO)[];

/**
 * A ÚNICA grafia que conta como produtor de uma recusa de kit: a constante.
 * ⚠️ Nunca o slug entre aspas — uma união de TIPOS soletra os slugs entre aspas
 * e não produz nada (S3F-06).
 */
function produzPelaConstante(fonte: string, chave: string): boolean {
  return fonte.includes(`MOTIVO_PROBLEMA_PUBLICACAO.${chave}`);
}

describe('O7 — todo membro do vocabulário tem um produtor fora de errosPublicacao.ts', () => {
  it('os 22 motivos de bloqueio: cada um é escrito por ALGUM outro arquivo', () => {
    // O arquivo que DECLARA está fora do universo, senão a asserção seria
    // vácua: a própria união de tipos soletra os 22 slugs.
    const fontes = fontesQuePodemProduzir(['errosPublicacao.ts']);
    // Uma âncora: se a leitura da pasta falhar, o teste passa sozinho.
    expect(fontes.size).toBeGreaterThan(10);
    expect(fontes.has('../../../app/api/marketplace/shopee/publicar/route.ts')).toBe(true);

    const orfaos: string[] = [];
    for (const [chave, slug] of Object.entries(MOTIVO_PUBLICACAO_BLOQUEADA)) {
      const grafias = [`'${slug}'`, `"${slug}"`, `MOTIVO_PUBLICACAO_BLOQUEADA.${chave}`];
      const temProdutor = [...fontes.values()].some((fonte) =>
        grafias.some((g) => fonte.includes(g)),
      );
      if (!temProdutor) orfaos.push(`${chave} (${slug})`);
    }

    expect(orfaos, 'motivos declarados que NINGUÉM produz').toEqual([]);
    expect(Object.keys(MOTIVO_PUBLICACAO_BLOQUEADA)).toHaveLength(22);
  });

  it('os 12 motivos só de WIRE: cada um também é escrito por ALGUM outro arquivo', () => {
    // A mesma regra para os membros que só um problema carrega — os dois de
    // `size_chart_info` (passo 18) entraram com um produtor cada (as linhas da
    // tabela de `problemasPublicacao.ts`), os sete de kit (passo 19) com as
    // linhas de `kits/recusaKit.ts`, e um membro novo sem produtor fica vermelho
    // aqui.
    const fontes = fontesQuePodemProduzir(['errosPublicacao.ts']);
    expect(fontes.has('problemasPublicacao.ts')).toBe(true);
    expect(fontes.has('../kits/recusaKit.ts')).toBe(true);

    const bloqueados = new Set<string>(Object.values(MOTIVO_PUBLICACAO_BLOQUEADA));
    const soDeWire = Object.entries(MOTIVO_PROBLEMA_PUBLICACAO).filter(
      ([, slug]) => !bloqueados.has(slug),
    );
    expect(soDeWire.map(([chave]) => chave).sort()).toEqual([
      'bloqueadoPorPromocao',
      'desconhecido',
      'faixaDeComponentes',
      'imagemDeKitDesligada',
      'impostoRecusado',
      'instabilidadeShopee',
      'kitBloqueadoPelaShopee',
      'kitInexistente',
      'kitPrincipalDuplicado',
      'operacaoInvalidaParaKit',
      'tabelaDeMedidasFotoRecusada',
      'tabelaDeMedidasRecusada',
    ]);

    const orfaos: string[] = [];
    for (const [chave, slug] of soDeWire) {
      const grafias = [`'${slug}'`, `"${slug}"`, `MOTIVO_PROBLEMA_PUBLICACAO.${chave}`];
      const temProdutor = [...fontes.values()].some((fonte) =>
        grafias.some((g) => fonte.includes(g)),
      );
      if (!temProdutor) orfaos.push(`${chave} (${slug})`);
    }
    expect(orfaos, 'motivos de wire declarados que NINGUÉM produz').toEqual([]);
  });

  it('M74 — as 7 recusas de KIT: o produtor mora em `kits/`, e O7 LÊ essa pasta', () => {
    // Antes do passo 19 a varredura lia só `anuncios/` e as três rotas. Um
    // membro produzido SÓ em `kits/recusaKit.ts` ficaria órfão — ou, se outra
    // menção qualquer o cobrisse, verde pelo motivo errado. Por isso a âncora é
    // a pasta no universo E o classificador produzindo os sete pela constante.
    const fontes = fontesQuePodemProduzir(['errosPublicacao.ts']);
    const recusaKit = fontes.get('../kits/recusaKit.ts');
    expect(recusaKit, 'kits/recusaKit.ts fora do universo de O7').toBeDefined();

    const semProdutorNoClassificador = CHAVES_DAS_RECUSAS_DE_KIT.filter(
      (chave) => !produzPelaConstante(recusaKit ?? '', chave),
    );
    expect(semProdutorNoClassificador).toEqual([]);

    // ⛔ QUASE-PAR: o `excluir` alcança `kits/` pela chave `../kits/<nome>` —
    // tirar o classificador do universo o tira de verdade.
    expect(fontesQuePodemProduzir(['../kits/recusaKit.ts']).has('../kits/recusaKit.ts')).toBe(
      false,
    );
  });

  it('M164 — ⛔ uma união de TIPOS com o slug entre aspas NÃO produz uma recusa de kit', () => {
    // S3F-06. O7 genérico conta qualquer grafia entre aspas, então uma
    // `type MotivoRecusaKit = '…' | '…'` em `kits/` manteria um membro
    // "produzido" depois de a sua linha da tabela sumir. Para os sete de kit a
    // ÚNICA grafia aceita é a constante — e nenhuma fonte de `kits/` soletra um
    // deles entre aspas.
    const uniao =
      'export type MotivoRecusaKit = \'kit-inexistente\' | "faixa-de-componentes";\n' +
      "const ROTULO = 'kit-principal-duplicado';";
    for (const chave of ['kitInexistente', 'faixaDeComponentes', 'kitPrincipalDuplicado']) {
      expect(produzPelaConstante(uniao, chave), chave).toBe(false);
    }
    // O PAR: a grafia da constante conta.
    expect(
      produzPelaConstante('motivo: MOTIVO_PROBLEMA_PUBLICACAO.kitInexistente,', 'kitInexistente'),
    ).toBe(true);

    const fontesKits = fontesDosKits();
    expect(fontesKits.has('../kits/recusaKit.ts')).toBe(true);
    const aspas: string[] = [];
    for (const [nome, fonte] of fontesKits) {
      for (const chave of CHAVES_DAS_RECUSAS_DE_KIT) {
        const slug = MOTIVO_PROBLEMA_PUBLICACAO[chave];
        if (fonte.includes(`'${slug}'`) || fonte.includes(`"${slug}"`)) {
          aspas.push(`${nome}: ${slug}`);
        }
      }
    }
    expect(aspas, 'slugs de kit soletrados entre aspas em kits/').toEqual([]);
  });

  it('os 11 motivos de tax_info omitido: cada um é escrito pela CONSTANTE companheira', () => {
    // ⚠️ Assimetria deliberada com o teste acima, e ela é o que o mantém
    // afiado: aqui o arquivo que declara (`taxInfoPublicacao.ts`) é também o
    // produtor de nove dos onze, então excluí-lo tornaria o teste impossível de
    // passar. Em troca, a grafia aceita é SÓ a da constante companheira — e ela
    // não aparece na declaração, que soletra slugs crus. Um membro acrescentado
    // à união sem um `MOTIVO_TAX_INFO_OMITIDO.<chave>` em lugar nenhum falha
    // aqui, que é exatamente a propriedade que se quer.
    const fontes = fontesQuePodemProduzir([]);
    expect(fontes.has('taxInfoPublicacao.ts')).toBe(true);
    expect(fontes.has('lerImpostoDoProduto.ts')).toBe(true);

    const orfaos: string[] = [];
    for (const chave of Object.keys(MOTIVO_TAX_INFO_OMITIDO)) {
      const grafia = `MOTIVO_TAX_INFO_OMITIDO.${chave}`;
      if (![...fontes.values()].some((fonte) => fonte.includes(grafia))) orfaos.push(chave);
    }

    expect(orfaos, 'motivos de imposto declarados que NINGUÉM produz').toEqual([]);
    expect(Object.keys(MOTIVO_TAX_INFO_OMITIDO)).toHaveLength(11);
  });

  it('`recusado-incompleto` é produzido pelo publicador, e `sem-operacao` pelo leitor', () => {
    // Os dois membros que NÃO nascem no mapeador puro. Nomeá-los aqui é o que
    // impede o teste acima de continuar verde depois de a nova-tentativa única
    // do C13 ou a cascata de operação serem removidas.
    const publicador = readFileSync(new URL('./publicarAnuncio.ts', RAIZ_ANUNCIOS), 'utf8');
    const leitor = readFileSync(new URL('./lerImpostoDoProduto.ts', RAIZ_ANUNCIOS), 'utf8');

    expect(publicador).toContain(`MOTIVO_TAX_INFO_OMITIDO.${'recusadoIncompleto'}`);
    expect(leitor).toContain(`MOTIVO_TAX_INFO_OMITIDO.${'semOperacao'}`);
  });
});
