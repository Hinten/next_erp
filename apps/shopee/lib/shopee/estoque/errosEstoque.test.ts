import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MAX_MENSAGEM_PROBLEMA } from '../anuncios/constantesAnuncio';
import { erroContidoPorConta } from '../core/containment';
import { ShopeeTasksDisabledError } from '../shopeeTasks';
import {
  CODIGO_GUARDA_ENVIO,
  MENSAGEM_POR_MOTIVO,
  MOTIVOS_QUE_ANOTAM,
  MOTIVO_ESTOQUE_SHOPEE,
  RESULTADO_MODELO,
  STATUS_POR_CODIGO_DE_GUARDA,
  ShopeeEnvioEstoqueGuardError,
  ShopeeStockTasksDisabledError,
  ehRecusa,
  limitarMensagemEstoque,
  type MotivoEstoqueShopee,
} from './errosEstoque';

/** Every slug, in the order the union declares them. */
const TODOS = Object.values(MOTIVO_ESTOQUE_SHOPEE);

describe('MotivoEstoqueShopee', () => {
  it('1 — o vocabulário é EXATAMENTE estes quarenta e sete slugs', () => {
    // Um vocabulário PERSISTIDO (`estoqueRecusaMotivo`, o corpo do envio manual,
    // um filtro futuro na web). O `as const satisfies` garante o TIPO dos
    // valores, mas não impede que um membro seja renomeado nos DOIS lugares de
    // uma vez — que é exatamente o refactor silencioso que órfã toda linha já
    // escrita. A igualdade de conjunto contra literais é o que fica vermelho aí.
    expect([...TODOS].sort()).toEqual([
      'anuncio-banido',
      'anuncio-de-outra-loja',
      'anuncio-em-revisao',
      'anuncio-inexistente',
      'anuncio-nao-editavel',
      'anuncio-removido',
      'bloqueado-por-promocao',
      'clampado-na-reserva',
      'conta-fora-do-produto',
      'conta-nao-configurada',
      'conta-pausada',
      'cota-diaria',
      'envio-parcial',
      'estrutura-de-estoque-divergente',
      'familia-sem-quantidade',
      'forma-de-modelo-divergente',
      'kit-derivado',
      'loja-armazem',
      'loja-banida-ou-congelada',
      'loja-cbsc',
      'loja-cnsc-nao-migrada',
      'loja-com-penalidade',
      'loja-em-ferias',
      'loja-fbs',
      'loja-outlet',
      'loja-vsku',
      'modelo-invalido',
      'modelo-sem-resposta',
      'multi-armazem',
      'pausa-reenqueues-esgotados',
      'payload-invalido',
      'piso-acima-da-banda',
      'piso-de-reserva-nao-atendido',
      'produto-nao-encontrado',
      'reauth',
      'recusa-anterior',
      'recusa-desconhecida',
      'sem-deposito',
      'sem-item-id',
      'sem-link',
      'sem-modelos',
      'sem-permissao',
      'sem-shop-id',
      'sync-desabilitado',
      'task-excede-limite',
      'tasks-desabilitadas',
      'tempo-esgotado',
    ]);
    expect(TODOS).toHaveLength(47);
    expect(new Set(TODOS).size).toBe(47);
  });

  it('2 — ⛔ NEAR-MISS: `nao-publicado` NÃO é membro, e os quatro estados que ENVIAM também não', () => {
    // As duas metades da mesma regra — um membro só existe se algo o produz.
    //
    // `nao-publicado` saiu porque a porteira `publicado` foi REMOVIDA da
    // descoberta de estoque deste ERP (#1087/#804) e a consulta não lê o campo:
    // nada consegue escrever essa recusa. Os outros quatro saíram pelo caminho
    // oposto do mesmo raciocínio — um anúncio agendado, pausado pelo ERP, com
    // estado desconhecido ou deslistado ENVIA, então nomear uma recusa para
    // eles seria prometer um veredicto que o código nunca dá.
    const valores: readonly string[] = TODOS;
    for (const fantasma of [
      'nao-publicado',
      'anuncio-agendado',
      'pausado-pelo-erp',
      'status-desconhecido',
      'anuncio-nao-enviavel',
    ]) {
      expect(valores, fantasma).not.toContain(fantasma);
    }

    // O par que dá sentido: os cinco sinônimos DEDUPADOS resolveram cada um
    // para UM slug, e é o slug sobrevivente que está aqui.
    expect(valores).toContain('loja-fbs'); // `loja-fbs-pura` e `estoque-fbs` viraram este
    expect(valores).toContain('loja-em-ferias'); // `feriado-total` virou este
    expect(valores).toContain('multi-armazem'); // `conta-multi-deposito` virou este
    expect(valores).toContain('sem-link'); // `sem-anuncio` virou este
    expect(valores).toContain('produto-nao-encontrado'); // `familia-nao-encontrada` virou este
  });

  it('3 — todo slug é kebab-case ASCII minúsculo', () => {
    // O slug viaja em JSON, vira chave de agrupamento e aparece numa URL de
    // filtro: acento, espaço, maiúscula e `_` estão todos fora.
    for (const slug of TODOS) expect(slug, slug).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
  });

  it('4 — as CHAVES do const casam com os slugs em camelCase', () => {
    // O `as const satisfies` já garante o TIPO dos valores; isto garante que a
    // chave que o código escreve (`MOTIVO_ESTOQUE_SHOPEE.semLink`) e o slug que
    // o Firestore guarda (`sem-link`) não possam divergir em silêncio.
    for (const [chave, slug] of Object.entries(MOTIVO_ESTOQUE_SHOPEE)) {
      const emCamel = slug.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      expect(chave, slug).toBe(emCamel);
    }
    expect(Object.keys(MOTIVO_ESTOQUE_SHOPEE)).toHaveLength(47);
  });
});

describe('MENSAGEM_POR_MOTIVO', () => {
  it('5 — é TOTAL nos dois sentidos: nenhum membro sem frase, nenhuma frase órfã', () => {
    // #1226 medido na gêmea do Mercado Livre: um motivo novo compilou, nenhum
    // teste falhou, e o envio manual respondeu quatro palavras sem causa e sem
    // remédio. O TIPO (`Record<MotivoEstoqueShopee, string>`) pega a primeira
    // metade em compilação; esta asserção pega a segunda, que o compilador não
    // vê — uma frase deixada para trás depois de um membro removido.
    const total: Record<MotivoEstoqueShopee, string> = MENSAGEM_POR_MOTIVO;
    expect(Object.keys(total).sort()).toEqual([...TODOS].sort());
  });

  it('6 — toda frase tem CAUSA e REMÉDIO: duas orações, em pt-BR, sem prosa vazia', () => {
    // "Não enviado." é uma frase e não é uma resposta. A contagem de orações é
    // o proxy barato para a propriedade real (dizer o que houve E o que fazer),
    // e o piso de comprimento impede que duas abreviações a satisfaçam.
    for (const [motivo, frase] of Object.entries(MENSAGEM_POR_MOTIVO)) {
      const oracoes = frase.match(/[.!?](?:\s|$)/g) ?? [];
      expect(oracoes.length, `${motivo}: ${frase}`).toBeGreaterThanOrEqual(2);
      expect(frase.length, motivo).toBeGreaterThan(60);
      expect(frase.trim(), motivo).toBe(frase);
    }
  });

  it('7 — ⛔ nenhuma frase carrega id, token ou nome de produto', () => {
    // A frase é PERSISTIDA e devolvida num corpo HTTP, então o que entra aqui é
    // publicado duas vezes. Uma corrida de seis dígitos é a assinatura barata
    // de um id de anúncio, de modelo, de loja ou de promoção coladas na prosa;
    // `item_name` é a única via pela qual um nome de produto da Shopee poderia
    // chegar aqui.
    for (const [motivo, frase] of Object.entries(MENSAGEM_POR_MOTIVO)) {
      expect(frase, motivo).not.toMatch(/\d{6,}/);
      expect(frase, motivo).not.toContain('item_name');
      expect(frase, motivo).not.toContain('partner_id');
      expect(frase, motivo).not.toContain('access_token');
    }
  });

  it('8 — as frases que o passo fixou chegam VERBATIM', () => {
    // Três âncoras. Reescrever uma delas é legítimo; reescrevê-la POR ACIDENTE
    // (uma "melhoria" de redação que troca o campo citado, ou que promete um
    // remédio diferente do que o código faz) é o que este teste pega.
    expect(MENSAGEM_POR_MOTIVO['kit-derivado']).toContain('o campo é kitNativo');
    expect(MENSAGEM_POR_MOTIVO['sync-desabilitado']).toContain('SHOPEE_STOCK_SYNC_ENABLED');
    expect(MENSAGEM_POR_MOTIVO['cota-diaria']).toContain('UTC+8');
    expect(MENSAGEM_POR_MOTIVO['bloqueado-por-promocao']).toContain('60 minutos');
  });

  it('8b — ⛔ `produto-nao-encontrado` promete SÓ o que o caminho faz: o documento não existe', () => {
    // O leitor por ids do envio manual não aplica predicado de âncora, então o
    // id de uma VARIAÇÃO volta como linha e o planejador a recusa por outro
    // motivo (`conta-fora-do-produto` ou `sem-link` — `enviarEstoqueCli.test.ts`
    // fixa isso no planejador real). Uma versão anterior desta frase acrescentava
    // "ou não é o produto âncora da família", e mandava o operador procurar uma
    // causa que este motivo nunca tem.
    const frase = MENSAGEM_POR_MOTIVO['produto-nao-encontrado'];
    expect(frase).toContain('não foi encontrado no ERP');
    expect(frase).not.toMatch(/âncora|varia/i);
  });
});

describe('ehRecusa / MOTIVOS_QUE_ANOTAM', () => {
  it('9 — PAR: `clampado-na-reserva` ANOTA um envio bem-sucedido, não o recusa', () => {
    // O clamp acompanha um envio que a Shopee ACEITOU — a quantidade foi
    // elevada para atender à reserva de uma promoção. Contá-lo como recusa
    // reportaria um anúncio sincronizado como falho e esconderia a única coisa
    // sobre a qual o operador precisa agir.
    expect(MOTIVOS_QUE_ANOTAM.has('clampado-na-reserva')).toBe(true);
    expect(ehRecusa('clampado-na-reserva')).toBe(false);
    expect(MOTIVOS_QUE_ANOTAM.size).toBe(1);
  });

  it('10 — ⛔ NEAR-MISS: todo OUTRO membro é recusa, incluindo os dois mais parecidos', () => {
    // O par que dá sentido ao teste 9: sem ele, `ehRecusa` devolvendo `false`
    // para tudo passaria. Os dois vizinhos de significado — o piso que a Shopee
    // RECUSOU e o piso que nem cabe na banda — são recusas de verdade, e são
    // exatamente os que uma "simplificação" agruparia com a anotação.
    expect(ehRecusa('sem-link')).toBe(true);
    expect(ehRecusa('piso-de-reserva-nao-atendido')).toBe(true);
    expect(ehRecusa('piso-acima-da-banda')).toBe(true);
    const anotam = TODOS.filter((m) => !ehRecusa(m));
    expect(anotam).toEqual(['clampado-na-reserva']);
  });
});

describe('LinhaDeModeloEnviada / RESULTADO_MODELO', () => {
  it('11 — o resultado por modelo tem TRÊS estados, e o terceiro não é um default', () => {
    // Uma chamada devolve `success_list` e `failure_list`. Um modelo que não
    // aparece em NENHUMA das duas tem de ser reportado como não atribuído:
    // dobrá-lo em `enviado` reporta uma quantidade que pode nunca ter chegado,
    // e dobrá-lo em `recusado` inventa uma recusa que a Shopee não fez.
    expect([...Object.values(RESULTADO_MODELO)].sort()).toEqual([
      'enviado',
      'recusado',
      'sem-resposta',
    ]);
  });
});

describe('limitarMensagemEstoque', () => {
  it('12 — PAR: uma mensagem no teto passa INTACTA', () => {
    const noLimite = 'a'.repeat(MAX_MENSAGEM_PROBLEMA);
    expect(limitarMensagemEstoque(noLimite)).toBe(noLimite);
    expect(limitarMensagemEstoque('')).toBe('');
  });

  it('13 — ⛔ NEAR-MISS: uma acima do teto é CORTADA, e nunca passa dele', () => {
    // O ponto de delegar em vez de declarar um segundo teto: os dois valores
    // terminam no mesmo lugar (um campo do documento de vínculo mais um corpo
    // HTTP), então dois números significariam uma superfície cortando e a outra
    // não — divergência visível só na única string grande que ninguém testou.
    const umAMais = 'a'.repeat(MAX_MENSAGEM_PROBLEMA + 1);
    const cortada = limitarMensagemEstoque(umAMais);
    expect(cortada).not.toBe(umAMais);
    expect(cortada).toHaveLength(MAX_MENSAGEM_PROBLEMA);
    expect(cortada.endsWith('…')).toBe(true);
  });
});

describe('ShopeeStockTasksDisabledError', () => {
  it('14 — é um Error com nome próprio, e NÃO é a classe compartilhada de tasks', () => {
    const err = new ShopeeStockTasksDisabledError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ShopeeStockTasksDisabledError');
    expect(err).not.toBeInstanceOf(ShopeeTasksDisabledError);
    expect(new ShopeeTasksDisabledError()).not.toBeInstanceOf(ShopeeStockTasksDisabledError);
  });

  it('15 — ⛔ NÃO é contida por conta — a válvula tem de derrubar o tick, alto', () => {
    // A célula decisiva. A classe compartilhada É contida, e para uma varredura
    // de notificações isso está certo. Aqui é a forma do apagão silencioso: a
    // válvula é um estado da IMPLANTAÇÃO, não da conta, então contê-la
    // escreveria N `lastError` idênticos, um por conta, e reportaria um tick
    // verde com nada sincronizado — o argumento do #778 que o próprio módulo de
    // contenção já faz para o erro de configuração.
    expect(erroContidoPorConta(new ShopeeStockTasksDisabledError())).toBe(false);

    // ⛔ O par que dá sentido: a classe compartilhada continua contida, de
    // propósito. Sem esta linha a asserção acima passaria mesmo com a contenção
    // desligada para todo mundo.
    expect(erroContidoPorConta(new ShopeeTasksDisabledError())).toBe(true);
  });

  it('16 — ⛔ `core/containment.ts` não nomeia esta classe, medido no TEXTO', () => {
    // Medido no texto porque o que se quer pegar é um acréscimo à lista de
    // contenção — e esse acréscimo compila, não quebra nenhum teste daquele
    // módulo, e só aparece como um apagão silencioso meses depois. O teste 15
    // pega o comportamento; este pega a intenção antes de ela virar
    // comportamento em outro caminho.
    const contencao = readFileSync(
      fileURLToPath(new URL('../core/containment.ts', import.meta.url)),
      'utf8',
    );
    expect(contencao).toContain('ShopeeTasksDisabledError'); // âncora: o arquivo é o certo
    expect(contencao.includes('ShopeeStockTasksDisabledError')).toBe(false);
  });
});

describe('ShopeeEnvioEstoqueGuardError', () => {
  it('17 — são EXATAMENTE dois códigos, e o status é DERIVADO de cada um', () => {
    // 400 = "esta conta não consegue responder a este pedido de jeito nenhum"
    // (sem depósito não há de onde ler quantidade, e esperar não muda isso);
    // 409 = "agora não" (a conta está em pausa, e o pedido idêntico funciona
    // quando ela vencer). É o que diz ao operador se ele conserta ou espera.
    expect([...Object.values(CODIGO_GUARDA_ENVIO)].sort()).toEqual([
      'SHOPEE_CONTA_PAUSADA',
      'SHOPEE_CONTA_SEM_DEPOSITO',
    ]);
    expect(Object.keys(STATUS_POR_CODIGO_DE_GUARDA).sort()).toEqual(
      [...Object.values(CODIGO_GUARDA_ENVIO)].sort(),
    );

    const semDeposito = new ShopeeEnvioEstoqueGuardError(
      CODIGO_GUARDA_ENVIO.contaSemDeposito,
      'conta sem depósito vinculado',
    );
    const pausada = new ShopeeEnvioEstoqueGuardError(
      CODIGO_GUARDA_ENVIO.contaPausada,
      'conta em pausa',
      { pausadoAte: 1 },
    );

    expect(semDeposito.status).toBe(400);
    expect(pausada.status).toBe(409);
    expect(semDeposito.code).toBe('SHOPEE_CONTA_SEM_DEPOSITO');
    expect(pausada.extra).toEqual({ pausadoAte: 1 });
    expect(semDeposito.extra).toEqual({});
  });

  it('18 — carrega um NÚMERO e se anuncia pelo `name`; a pasta continua sem Next', () => {
    // A pasta inteira é alcançada pelo bundle de Cloud Functions, então
    // `next/server` não pode aparecer nela: a rota mapeia esta classe para uma
    // resposta no catch DELA, e a dependência corre num sentido só.
    const err = new ShopeeEnvioEstoqueGuardError(CODIGO_GUARDA_ENVIO.contaPausada, 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ShopeeEnvioEstoqueGuardError');
    expect(typeof err.status).toBe('number');
    expect(err.message).toBe('x');

    // ⚠️ O nome do módulo é montado em tempo de execução: o grep de disciplina
    // da pasta procura essa string CRUA, e soletrá-la aqui só não é uma
    // violação porque aquele grep exclui testes — uma exclusão da qual este
    // arquivo não precisa depender.
    const fonte = readFileSync(
      fileURLToPath(new URL('./errosEstoque.ts', import.meta.url)),
      'utf8',
    );
    expect(fonte.includes(['next', 'server'].join('/'))).toBe(false);
  });

  it('19 — ⛔ NÃO é contida por conta: ela ABORTA o pedido inteiro, por definição', () => {
    // O oposto do erro por anúncio: nenhuma destas duas pode ser reportada por
    // listagem, porque cada uma para o pedido antes de qualquer listagem ser
    // considerada. Contê-la transformaria um 400/409 honesto num 200 com uma
    // lista vazia.
    expect(
      erroContidoPorConta(
        new ShopeeEnvioEstoqueGuardError(CODIGO_GUARDA_ENVIO.contaSemDeposito, 'x'),
      ),
    ).toBe(false);
  });
});
