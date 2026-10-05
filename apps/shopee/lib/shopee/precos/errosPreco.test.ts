import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ShopeeApiError, ShopeeError } from '@delfrance/integrations-shopee';

import { erroContidoPorConta } from '../core/containment';
import { CODIGO_GUARDA_ENVIO, MOTIVO_ESTOQUE_SHOPEE } from '../estoque/errosEstoque';
import {
  CODIGO_GUARDA_PRECO,
  MENSAGEM_ENVIO_PRECO_LIMPO,
  MENSAGEM_POR_MOTIVO_PRECO,
  MOTIVOS_QUE_CARIMBAM,
  MOTIVO_PRECO_SHOPEE,
  STATUS_POR_CODIGO_DE_GUARDA_PRECO,
  ShopeeEnvioPrecoGuardError,
  mensagemDoMotivoDePreco,
  type MotivoPrecoShopee,
} from './errosPreco';

/** Every slug, in the order the union declares them. */
const TODOS: readonly MotivoPrecoShopee[] = Object.values(MOTIVO_PRECO_SHOPEE);

/** The sentence an unknown stored motivo renders — spelled once for the assertions. */
const GENERICA = 'Não enviado (motivo não reconhecido).';

/** This module's raw TEXT — two properties below are measured on it. */
const FONTE = readFileSync(fileURLToPath(new URL('./errosPreco.ts', import.meta.url)), 'utf8');

/** Type-level equality: `true` only when A and B are the same set of literals. */
type Igual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('MotivoPrecoShopee', () => {
  it('1 — o vocabulário é EXATAMENTE estes quarenta e seis slugs (44 do PR 1 + os 2 do job)', () => {
    // PERSISTIDO (`precoRecusaMotivo`, as linhas do relatório, o corpo do envio
    // manual). O `as const satisfies` garante o TIPO dos valores, mas não impede
    // um renome feito nos DOIS lugares de uma vez — o refactor silencioso que
    // órfã toda linha já escrita. A igualdade contra literais é o que fica
    // vermelho aí.
    expect([...TODOS].sort()).toEqual([
      'anuncio-banido',
      'anuncio-de-outra-loja',
      'anuncio-em-revisao',
      'anuncio-inexistente',
      'anuncio-nao-editavel',
      'anuncio-removido',
      'bloqueado-por-promocao',
      'conflito-com-atacado',
      'conta-nao-configurada',
      'conta-pausada',
      'envio-parcial',
      'forma-de-modelo-divergente',
      'job-cancelado',
      'job-interrompido',
      'kit-derivado',
      'loja-banida-ou-congelada',
      'loja-com-penalidade',
      'loja-cross-border',
      'loja-vsku',
      'modelo-ausente',
      'modelo-invalido',
      'modelo-sem-resposta',
      'modelos-excedem-limite',
      'moeda-divergente',
      'preco-acima-do-limite-do-frete',
      'preco-atual-ilegivel',
      'preco-fora-da-faixa',
      'preco-igual',
      'preco-invalido',
      'preco-menor-bloqueado',
      'preco-nao-atualizado',
      'preco-nao-encontrado',
      'preco-recusado',
      'preco-riscado',
      'produto-nao-encontrado',
      'razao-de-precos-excedida',
      'reauth',
      'recusa-desconhecida',
      'regiao-nao-suportada',
      'sem-item-id',
      'sem-link',
      'sem-modelos',
      'sem-permissao',
      'sem-shop-id',
      'sem-tabela-normal',
      'tempo-esgotado',
    ]);
    expect(TODOS).toHaveLength(46);
    expect(new Set(TODOS).size).toBe(46);
  });

  it('2 — o const cobre a união INTEIRA, nos dois sentidos, em tempo de compilação', () => {
    // O `satisfies` prova que todo VALOR é membro, jamais que todo membro está
    // no const. Esta igualdade de tipos fecha a outra metade: um membro novo na
    // união sem a entrada no const é erro de `tsc` aqui.
    type ValoresDoConst = (typeof MOTIVO_PRECO_SHOPEE)[keyof typeof MOTIVO_PRECO_SHOPEE];
    const cobre: Igual<ValoresDoConst, MotivoPrecoShopee> = true;
    expect(cobre).toBe(true);
  });

  it('3 — PAR: `preco-recusado` é o 44º membro, e os sobreviventes das fusões estão aqui', () => {
    const valores: readonly string[] = TODOS;
    expect(valores).toContain('preco-recusado'); // Apêndice C, C-2
    expect(valores).toContain('kit-derivado'); // venceu `kit-nativo`
    expect(valores).toContain('produto-nao-encontrado'); // absorveu `familia-nao-encontrada`
    expect(valores).toContain('modelos-excedem-limite'); // o `modelos-demais` do plano
    expect(valores).toContain('bloqueado-por-promocao'); // a grafia do estoque
    expect(valores).toContain('preco-riscado'); // promoção de preço riscado ≠ oferta relâmpago
  });

  it('4 — ⛔ NEAR-MISS: os nomes que a reconciliação CORTOU ou adiou não são membros', () => {
    // Um membro só existe se algo o produz. Os do job chegaram no PR 2 junto
    // com o produtor; `cota-diaria`/`burst` são valores de PAUSA da conta, não
    // recusas de linha; um status desconhecido ENVIA; e as grafias UPPER_SNAKE
    // e as alternativas do desenho D1/D2 perderam para a do estoque.
    const valores: readonly string[] = TODOS;
    for (const fantasma of [
      'kit-nativo',
      'familia-nao-encontrada',
      'status-desconhecido',
      'cota-diaria',
      'burst',
      'modelos-demais',
      'preco-em-promocao',
      'em-slash-sale',
      'conflito-com-oferta-relampago',
      'codigo-nao-classificado',
      'limite-de-taxa',
    ]) {
      expect(valores, fantasma).not.toContain(fantasma);
    }
  });

  it('5 — todo slug é kebab-case ASCII minúsculo', () => {
    for (const slug of TODOS) expect(slug, slug).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
  });

  it('6 — as CHAVES do const casam com os slugs em camelCase', () => {
    for (const [chave, slug] of Object.entries(MOTIVO_PRECO_SHOPEE)) {
      const emCamel = slug.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      expect(chave, slug).toBe(emCamel);
    }
    expect(Object.keys(MOTIVO_PRECO_SHOPEE)).toHaveLength(46);
  });

  it('7 — PAR: a condição que o ESTOQUE já nomeia usa a MESMA grafia (uma palavra por condição)', () => {
    // O operador lê a recusa de estoque e a de preço do mesmo anúncio lado a
    // lado; duas palavras para uma condição é o que isto proíbe.
    const doEstoque: readonly string[] = Object.values(MOTIVO_ESTOQUE_SHOPEE);
    for (const compartilhado of [
      'sem-link',
      'sem-item-id',
      'kit-derivado',
      'anuncio-removido',
      'forma-de-modelo-divergente',
      'sem-modelos',
      'produto-nao-encontrado',
      'tempo-esgotado',
      'conta-pausada',
      'modelo-invalido',
      'anuncio-inexistente',
      'anuncio-de-outra-loja',
      'anuncio-banido',
      'anuncio-em-revisao',
      'anuncio-nao-editavel',
      'loja-vsku',
      'bloqueado-por-promocao',
      'recusa-desconhecida',
      'envio-parcial',
      'modelo-sem-resposta',
      'sem-shop-id',
      'conta-nao-configurada',
      'loja-banida-ou-congelada',
      'reauth',
      'loja-com-penalidade',
      'sem-permissao',
    ] as const satisfies readonly MotivoPrecoShopee[]) {
      expect(doEstoque, compartilhado).toContain(compartilhado);
    }
  });

  it('8 — ⛔ NEAR-MISS: a grafia é compartilhada, o TIPO não — este módulo não importa o do estoque', () => {
    // Um membro acrescentado a um vocabulário não pode alargar o outro em
    // silêncio: cada pasta é dona do seu.
    // Medido nos IMPORTS (o docblock cita o módulo do estoque como a forma que
    // este segue, e citar não é depender).
    expect(FONTE).toContain("from '@delfrance/integrations-shopee';"); // âncora
    expect(FONTE).not.toMatch(/from '[^']*estoque[^']*'/);
    expect(FONTE.includes('MotivoEstoqueShopee')).toBe(false);
  });
});

describe('MENSAGEM_POR_MOTIVO_PRECO', () => {
  it('9 — é TOTAL nos dois sentidos: nenhum membro sem frase, nenhuma frase órfã', () => {
    // O TIPO (`Record<MotivoPrecoShopee, string>`) pega a primeira metade em
    // compilação — #1226, medido na gêmea do ML; esta asserção pega a segunda,
    // uma frase deixada para trás depois de um membro removido.
    const total: Record<MotivoPrecoShopee, string> = MENSAGEM_POR_MOTIVO_PRECO;
    expect(Object.keys(total).sort()).toEqual([...TODOS].sort());
  });

  it('10 — toda frase é pt-BR não vazia, aparada, terminada em ponto — e nunca o próprio slug', () => {
    for (const motivo of TODOS) {
      const frase = MENSAGEM_POR_MOTIVO_PRECO[motivo];
      expect(frase.length, motivo).toBeGreaterThan(15);
      expect(frase.trim(), motivo).toBe(frase);
      expect(frase.endsWith('.'), motivo).toBe(true);
      expect(frase, motivo).not.toBe(motivo);
      // Nenhuma frase é uma sequência kebab (um slug colado como mensagem).
      expect(frase, motivo).not.toMatch(/^[a-z]+(?:-[a-z]+)+\.?$/);
    }
  });

  it('11 — ⛔ nenhuma frase carrega id, token ou prosa do provedor', () => {
    for (const motivo of TODOS) {
      const frase = MENSAGEM_POR_MOTIVO_PRECO[motivo];
      expect(frase, motivo).not.toMatch(/\d{6,}/);
      for (const proibido of ['item_name', 'partner_id', 'access_token', 'try later', 'error_']) {
        expect(frase.includes(proibido), `${motivo}: ${proibido}`).toBe(false);
      }
    }
  });

  it('12 — ⛔ nenhuma frase de membro é a genérica nem a de envio limpo', () => {
    // Se uma delas coincidisse, uma linha recusada e uma linha desconhecida (ou
    // enviada) seriam indistinguíveis na tela.
    for (const motivo of TODOS) {
      expect(MENSAGEM_POR_MOTIVO_PRECO[motivo], motivo).not.toBe(GENERICA);
      expect(MENSAGEM_POR_MOTIVO_PRECO[motivo], motivo).not.toBe(MENSAGEM_ENVIO_PRECO_LIMPO);
    }
    expect(MENSAGEM_ENVIO_PRECO_LIMPO).toBe('Preço enviado à Shopee.');
  });

  it('13 — `preco-recusado` nomeia as causas MEDIDAS, não o conselho falso da Shopee', () => {
    // A sonda mediu `error_update_price_fail` para uma razão excedida (inclusive
    // contra um irmão NÃO enviado), um anúncio excluído e uma estrutura de
    // variações alterada; o texto da Shopee ("please try later") é falso para
    // todos. A frase é a do Apêndice C, C-2, verbatim.
    expect(MENSAGEM_POR_MOTIVO_PRECO['preco-recusado']).toBe(
      'A Shopee recusou a atualização de preço sem detalhar o motivo. Causas medidas: a diferença entre o maior e o menor preço das variações (incluindo as que não foram enviadas) acima do limite, anúncio excluído, ou variações do anúncio alteradas na Shopee. Confira o anúncio e reimporte-o se as variações mudaram.',
    );
    expect(MENSAGEM_POR_MOTIVO_PRECO['preco-recusado']).not.toMatch(
      /tente (novamente )?mais tarde/i,
    );
  });

  it('14 — as frases que o passo fixou chegam VERBATIM (âncoras de §2.8)', () => {
    expect(MENSAGEM_POR_MOTIVO_PRECO['kit-derivado']).toContain('(kitNativo)');
    expect(MENSAGEM_POR_MOTIVO_PRECO['modelos-excedem-limite']).toContain('(50)');
    expect(MENSAGEM_POR_MOTIVO_PRECO['preco-atual-ilegivel']).toContain(
      'Envie autorizando a redução para forçar.',
    );
    expect(MENSAGEM_POR_MOTIVO_PRECO['regiao-nao-suportada']).toContain('lojas BR');
  });
});

describe('mensagemDoMotivoDePreco', () => {
  it('15 — PAR: um membro rende a SUA frase — todos os quarenta e seis', () => {
    expect(mensagemDoMotivoDePreco('preco-igual')).toBe('O preço na Shopee já é igual ao do ERP.');
    for (const motivo of TODOS) {
      expect(mensagemDoMotivoDePreco(motivo), motivo).toBe(MENSAGEM_POR_MOTIVO_PRECO[motivo]);
    }
  });

  it('16 — ⛔ NEAR-MISS: um slug desconhecido rende a frase GENÉRICA, e nunca ecoa a entrada', () => {
    // Um valor gravado por outra versão (ou corrompido) não pode virar prosa que
    // o operador lê: ecoá-lo colaria uma string não validada na tela.
    for (const desconhecido of [
      'preco-qualquer',
      'PRECO_IGUAL', // a grafia UPPER_SNAKE do ML
      ' preco-igual', // um espaço a mais
      'preco-igual ',
      'Preco-igual',
      'cota-diaria', // valor de PAUSA, não motivo de linha
    ]) {
      const frase = mensagemDoMotivoDePreco(desconhecido);
      expect(frase, desconhecido).toBe(GENERICA);
      expect(frase.includes(desconhecido.trim()), desconhecido).toBe(false);
    }
  });

  it('17 — ⛔ NEAR-MISS: uma chave do PROTÓTIPO não é membro', () => {
    // O mutante clássico: `MENSAGEM_POR_MOTIVO_PRECO[motivo] ?? genérica`. Para
    // `constructor` aquilo devolve a FUNÇÃO `Object` (nunca `undefined`), e a
    // tela renderizaria o código-fonte dela como a frase do operador.
    for (const doPrototipo of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'valueOf',
    ]) {
      const frase = mensagemDoMotivoDePreco(doPrototipo);
      expect(typeof frase, doPrototipo).toBe('string');
      expect(frase, doPrototipo).toBe(GENERICA);
    }
  });

  it('18 — PAR: `null` é o envio LIMPO — a linha sem motivo foi enviada', () => {
    // A rota do relatório renderiza TODA linha por esta função, as enviadas
    // inclusive; a regra do estoque é a mesma (`motivo === null ? limpo : tabela`).
    expect(mensagemDoMotivoDePreco(null)).toBe(MENSAGEM_ENVIO_PRECO_LIMPO);
    expect(mensagemDoMotivoDePreco(null)).not.toBe(GENERICA);
  });

  it('19 — ⛔ NEAR-MISS: só o `null` literal é limpo — string vazia é DESCONHECIDA', () => {
    // Um `if (!motivo)` trataria `''` como envio limpo e anunciaria um preço
    // enviado para uma linha cujo motivo se perdeu.
    expect(mensagemDoMotivoDePreco('')).toBe(GENERICA);
    expect(mensagemDoMotivoDePreco('')).not.toBe(MENSAGEM_ENVIO_PRECO_LIMPO);
  });
});

describe('MOTIVOS_QUE_CARIMBAM', () => {
  it('20 — PAR: são EXATAMENTE os treze da §2.8 mais `preco-recusado` (catorze)', () => {
    expect([...MOTIVOS_QUE_CARIMBAM].sort()).toEqual([
      'anuncio-de-outra-loja',
      'anuncio-inexistente',
      'anuncio-nao-editavel',
      'conflito-com-atacado',
      'forma-de-modelo-divergente',
      'loja-vsku',
      'modelo-invalido',
      'moeda-divergente',
      'preco-acima-do-limite-do-frete',
      'preco-fora-da-faixa',
      'preco-invalido',
      'preco-recusado',
      'razao-de-precos-excedida',
      'recusa-desconhecida',
    ]);
    expect(MOTIVOS_QUE_CARIMBAM.has('preco-recusado')).toBe(true);
  });

  it('21 — todo membro do conjunto é membro da união (⊂)', () => {
    const valores: readonly string[] = TODOS;
    for (const m of MOTIVOS_QUE_CARIMBAM) expect(valores, m).toContain(m);
  });

  it('22 — ⛔ NEAR-MISS: trava, igualdade, conferência e o que é da LOJA não carimbam', () => {
    // C-n: uma trava de promoção termina sozinha (carimbá-la marcaria o anúncio
    // como quebrado pela duração da promoção); um preço igual não foi recusado
    // (carimbá-lo como sucesso atribuiria ao ERP um preço que o vendedor pode ter
    // posto à mão); uma conferência que falhou veio de um envio ACEITO; e as
    // fatais de conta são propriedade da LOJA, não deste anúncio.
    for (const naoCarimba of [
      'bloqueado-por-promocao',
      'preco-riscado',
      'preco-igual',
      'preco-nao-atualizado',
      'modelo-sem-resposta',
      'envio-parcial',
      'reauth',
      'loja-com-penalidade',
      'sem-permissao',
      'regiao-nao-suportada',
      'preco-menor-bloqueado',
      'preco-nao-encontrado',
      'modelo-ausente',
      'anuncio-banido',
    ] as const satisfies readonly MotivoPrecoShopee[]) {
      expect(MOTIVOS_QUE_CARIMBAM.has(naoCarimba), naoCarimba).toBe(false);
    }
  });
});

describe('ShopeeEnvioPrecoGuardError', () => {
  it('23 — são EXATAMENTE três códigos, e o status é DERIVADO de cada um: 400 / 409 / 422', () => {
    expect([...Object.values(CODIGO_GUARDA_PRECO)].sort()).toEqual([
      'SHOPEE_CONTA_PAUSADA',
      'SHOPEE_CONTA_SEM_TABELA_NORMAL',
      'SHOPEE_PRECO_CONTA_RECUSADA',
    ]);
    expect(Object.keys(STATUS_POR_CODIGO_DE_GUARDA_PRECO).sort()).toEqual(
      [...Object.values(CODIGO_GUARDA_PRECO)].sort(),
    );

    const semTabela = new ShopeeEnvioPrecoGuardError(
      CODIGO_GUARDA_PRECO.contaSemTabelaNormal,
      'conta sem tabela normal',
    );
    const pausada = new ShopeeEnvioPrecoGuardError(CODIGO_GUARDA_PRECO.contaPausada, 'em pausa', {
      pausadoAte: '2026-09-24T16:00:00.000Z',
    });
    const recusada = new ShopeeEnvioPrecoGuardError(
      CODIGO_GUARDA_PRECO.contaRecusada,
      'conta recusada',
      { motivo: 'regiao-nao-suportada', regiao: 'SG' },
    );

    expect(semTabela.status).toBe(400);
    expect(pausada.status).toBe(409);
    expect(recusada.status).toBe(422);
    expect(recusada.code).toBe('SHOPEE_PRECO_CONTA_RECUSADA');
    expect(pausada.extra).toEqual({ pausadoAte: '2026-09-24T16:00:00.000Z' });
    expect(semTabela.extra).toEqual({});
  });

  it('24 — PAR: a pausa responde o MESMO código do estoque (a web lê um código por condição)', () => {
    expect(CODIGO_GUARDA_PRECO.contaPausada).toBe(CODIGO_GUARDA_ENVIO.contaPausada);
  });

  it('25 — ⛔ NEAR-MISS: a recusa da conta é 422, não o 400 da tabela nem o 409 da pausa', () => {
    // 400 mandaria o chamador consertar o corpo, o que não ajuda; 409 diria
    // "espere", e esperar não muda a região de uma loja.
    expect(STATUS_POR_CODIGO_DE_GUARDA_PRECO.SHOPEE_PRECO_CONTA_RECUSADA).not.toBe(400);
    expect(STATUS_POR_CODIGO_DE_GUARDA_PRECO.SHOPEE_PRECO_CONTA_RECUSADA).not.toBe(409);
    expect(CODIGO_GUARDA_PRECO.contaRecusada).not.toBe(CODIGO_GUARDA_ENVIO.contaSemDeposito);
  });

  it('26 — é um ShopeeError com nome próprio, carrega um NÚMERO, e não é um erro de API', () => {
    const err = new ShopeeEnvioPrecoGuardError(CODIGO_GUARDA_PRECO.contaPausada, 'x');
    expect(err).toBeInstanceOf(ShopeeError);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ShopeeApiError);
    expect(err.name).toBe('ShopeeEnvioPrecoGuardError');
    expect(err.message).toBe('x');
    expect(typeof err.status).toBe('number');
  });

  it('27 — ⛔ NÃO é contida por conta: ela ABORTA o pedido inteiro, por definição', () => {
    expect(
      erroContidoPorConta(
        new ShopeeEnvioPrecoGuardError(CODIGO_GUARDA_PRECO.contaSemTabelaNormal, 'x'),
      ),
    ).toBe(false);
  });

  it('28 — ⛔ a pasta continua sem Next: o módulo não importa o servidor dele', () => {
    // Montado em tempo de execução: o grep de disciplina da pasta procura a
    // grafia CRUA, e soletrá-la aqui não é violação só porque aquele grep
    // exclui testes — uma exclusão da qual este arquivo não precisa depender.
    expect(FONTE.includes(['next', 'server'].join('/'))).toBe(false);
  });
});
