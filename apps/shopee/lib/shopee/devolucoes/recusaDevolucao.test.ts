import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_RETURN_DETAIL_PATH,
  SHOPEE_RETURN_ACCEPT_OFFER_PATH,
  SHOPEE_SURFACE,
  ShopeeApiError,
  shopeeErrorFromEnvelope,
} from '@delfrance/integrations-shopee';

import {
  CODIGOS_DA_RECUSA_DEVOLUCAO,
  FRASE_RECUSA_DEVOLUCAO,
  MOTIVO_RECUSA_DEVOLUCAO,
  classificarRecusaDevolucaoShopee,
  motivoRecusaDevolucaoSchema,
  type MotivoRecusaDevolucao,
} from './recusaDevolucao';

/* -------------------------------------------------------------------------- */
/*  Fixtures — the pages' own error sentences; no id, no buyer datum.         */
/* -------------------------------------------------------------------------- */

/**
 * The error the transport really builds for an envelope — the package's own
 * builder, so the class, the `kind` and the formatted `.message` are the ones
 * production sees.
 */
function doEnvelope(
  error: string,
  message: string | null,
  path: string = SHOPEE_RETURN_ACCEPT_OFFER_PATH,
): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: null, warning: null },
    { path, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

function classificar(error: string, message: string | null): MotivoRecusaDevolucao | null {
  return classificarRecusaDevolucaoShopee(doEnvelope(error, message));
}

/* ------------------------------ the vocabulary ------------------------------ */

describe('MOTIVO_RECUSA_DEVOLUCAO — o vocabulário único (R-6)', () => {
  it('os membros são EXATAMENTE os do schema — nem um a mais, nem um a menos', () => {
    expect(Object.values(MOTIVO_RECUSA_DEVOLUCAO).sort()).toEqual(
      [...motivoRecusaDevolucaoSchema.options].sort(),
    );
    expect(motivoRecusaDevolucaoSchema.options).toHaveLength(20);
  });

  it('cada chave é o slug em camelCase — o código nomeia o membro, nunca soletra o slug', () => {
    for (const [chave, slug] of Object.entries(MOTIVO_RECUSA_DEVOLUCAO)) {
      const camel = slug.replace(/-([a-z])/g, (_, letra: string) => letra.toUpperCase());
      expect(chave).toBe(camel);
    }
  });

  it('o schema recusa um slug fora do conjunto (o fio é fechado)', () => {
    expect(motivoRecusaDevolucaoSchema.safeParse('recusa-desconhecida').success).toBe(false);
    expect(motivoRecusaDevolucaoSchema.safeParse('Valor-Mudou').success).toBe(false);
    expect(motivoRecusaDevolucaoSchema.safeParse(MOTIVO_RECUSA_DEVOLUCAO.valorMudou).success).toBe(
      true,
    );
  });
});

describe('FRASE_RECUSA_DEVOLUCAO — a frase do `error` da rota', () => {
  const frases = Object.entries(FRASE_RECUSA_DEVOLUCAO);

  it('tem uma frase para cada membro, e só para eles', () => {
    expect(Object.keys(FRASE_RECUSA_DEVOLUCAO).sort()).toEqual(
      [...motivoRecusaDevolucaoSchema.options].sort(),
    );
  });

  it('toda frase é uma FRASE: maiúscula no começo, ponto no fim, sem resíduo de modelo', () => {
    for (const [motivo, frase] of frases) {
      expect(frase, motivo).toMatch(/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/);
      expect(frase, motivo).toMatch(/[^.]\.$/);
      expect(frase, motivo).not.toMatch(/undefined|null|\{|\}/);
    }
  });

  it('nenhuma frase carrega um identificador — nem número de pedido, nem de devolução', () => {
    for (const [motivo, frase] of frases) {
      expect(frase, motivo).not.toMatch(/\d/);
    }
  });

  it('duas razões nunca dizem a mesma coisa — a web mostra o texto verbatim', () => {
    expect(new Set(frases.map(([, frase]) => frase)).size).toBe(frases.length);
  });

  it('cada frase está no SEU membro — duas trocadas de lugar ficam vermelhas', () => {
    // One fragment per member, unique to its sentence: the shape tests above
    // pass for any permutation of the table, and a swapped pair tells the
    // operator to do the wrong thing with perfect grammar.
    const marca: Record<MotivoRecusaDevolucao, string> = {
      [MOTIVO_RECUSA_DEVOLUCAO.devolucaoEncerrada]: 'já foi encerrada',
      [MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite]: 'situação atual da devolução',
      [MOTIVO_RECUSA_DEVOLUCAO.devolucaoEmDisputa]: 'em disputa',
      [MOTIVO_RECUSA_DEVOLUCAO.tipoRequisicaoNaoPermite]: 'tipo desta solicitação',
      [MOTIVO_RECUSA_DEVOLUCAO.validacaoPeloArmazem]: 'armazém',
      [MOTIVO_RECUSA_DEVOLUCAO.tipoReembolsoNaoPermite]: 'responda com reembolso',
      [MOTIVO_RECUSA_DEVOLUCAO.solucaoIndisponivel]: 'outra solução',
      [MOTIVO_RECUSA_DEVOLUCAO.valorNaoAjustavel]: 'sem valor',
      [MOTIVO_RECUSA_DEVOLUCAO.valorObrigatorio]: 'Informe o valor',
      [MOTIVO_RECUSA_DEVOLUCAO.valorForaDaFaixa]: 'faixa',
      [MOTIVO_RECUSA_DEVOLUCAO.semPropostaDoComprador]: 'não tem proposta pendente',
      [MOTIVO_RECUSA_DEVOLUCAO.propostaPropria]: 'da própria loja',
      [MOTIVO_RECUSA_DEVOLUCAO.negociacaoNaoPermite]: 'situação atual da negociação',
      [MOTIVO_RECUSA_DEVOLUCAO.evidenciaInicialPendente]: 'evidências iniciais',
      [MOTIVO_RECUSA_DEVOLUCAO.emAnalisePelaShopee]: 'análise da Shopee',
      [MOTIVO_RECUSA_DEVOLUCAO.valorMudou]: 'novo valor',
      [MOTIVO_RECUSA_DEVOLUCAO.propostaMudou]: 'nova proposta',
      [MOTIVO_RECUSA_DEVOLUCAO.pedidoDivergente]: 'outro pedido',
      [MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente]: 'não encontrou',
      [MOTIVO_RECUSA_DEVOLUCAO.parametroInvalido]: 'recusou um dos dados',
    };
    for (const [motivo, frase] of frases) {
      const minha = marca[motivo as MotivoRecusaDevolucao];
      expect(frase, motivo).toContain(minha);
      // …and no OTHER member's fragment sits in this sentence.
      for (const [outro, deOutro] of Object.entries(marca)) {
        if (outro !== motivo) expect(frase, `${motivo} ∌ ${outro}`).not.toContain(deOutro);
      }
    }
  });
});

/* ------------------------------ the classifier ------------------------------ */

describe('classificarRecusaDevolucaoShopee — as linhas decididas pelo CÓDIGO', () => {
  it.each<[string, string, MotivoRecusaDevolucao]>([
    [
      'error_return_status',
      'The return status cannot support this action',
      MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite,
    ],
    [
      'error_negotiation_status',
      'The negotiation status cannot support this action',
      MOTIVO_RECUSA_DEVOLUCAO.negociacaoNaoPermite,
    ],
    [
      'error_ongoing_dispute',
      'cannot offer refund to buyer when return has ongoing dispute',
      MOTIVO_RECUSA_DEVOLUCAO.devolucaoEmDisputa,
    ],
    [
      'error_no_buyer_offer',
      'cannot accept refund offer because there is no counter proposal from buyer',
      MOTIVO_RECUSA_DEVOLUCAO.semPropostaDoComprador,
    ],
    [
      'error_no_buyer_offer',
      'cannot accept refund offer because there is no proposal from buyer',
      MOTIVO_RECUSA_DEVOLUCAO.semPropostaDoComprador,
    ],
    ['err_data', 'Cannot accept your own offer.', MOTIVO_RECUSA_DEVOLUCAO.propostaPropria],
    [
      'error_return_request_type',
      'Action cannot be performed by shop because the Return Refund Request Type = 1',
      MOTIVO_RECUSA_DEVOLUCAO.tipoRequisicaoNaoPermite,
    ],
    [
      'error_validation',
      'Action cannot be performed by shop because the validation_type of Return/Refund request = warehouse_validation',
      MOTIVO_RECUSA_DEVOLUCAO.validacaoPeloArmazem,
    ],
    [
      'rraoc_refund_not_allowed',
      'Type of return does not allow seller to offer refund',
      MOTIVO_RECUSA_DEVOLUCAO.tipoReembolsoNaoPermite,
    ],
    [
      'error_param',
      'The proposed adjusted refund amount can not exceed max refund amount',
      MOTIVO_RECUSA_DEVOLUCAO.parametroInvalido,
    ],
    [
      'error_param',
      'This proposed solution is not one of the available solutions for this return.',
      MOTIVO_RECUSA_DEVOLUCAO.parametroInvalido,
    ],
    ['error_param', 'Return SN or ID is invalid.', MOTIVO_RECUSA_DEVOLUCAO.parametroInvalido],
  ])('%s — "%s" ⇒ %s', (codigo, frase, esperado) => {
    expect(classificar(codigo, frase)).toBe(esperado);
  });

  it('um código que decide sozinho decide SEM frase nenhuma (null e vazia)', () => {
    expect(classificar('error_ongoing_dispute', null)).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.devolucaoEmDisputa,
    );
    expect(classificar('err_data', '')).toBe(MOTIVO_RECUSA_DEVOLUCAO.propostaPropria);
  });
});

describe('classificarRecusaDevolucaoShopee — `error_data`, decidido pela FRASE', () => {
  it.each<[string, MotivoRecusaDevolucao]>([
    ["The return you queried doesn't exist.", MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente],
    ['The return detail is not available.', MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente],
    [
      'The return case is missing initial evidence from the buyer and will be auto-cancelled if the buyer does not provide evidence by the due date.',
      MOTIVO_RECUSA_DEVOLUCAO.evidenciaInicialPendente,
    ],
    [
      'Shopee is reviewing the case and will get back to you.',
      MOTIVO_RECUSA_DEVOLUCAO.emAnalisePelaShopee,
    ],
    ['Invalid return status: CLOSED', MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite],
    [
      'Type of return does not allow seller to offer refund',
      MOTIVO_RECUSA_DEVOLUCAO.tipoReembolsoNaoPermite,
    ],
    ['Accept offer is not available for this return', MOTIVO_RECUSA_DEVOLUCAO.negociacaoNaoPermite],
  ])('error_data — "%s" ⇒ %s', (frase, esperado) => {
    expect(classificar('error_data', frase)).toBe(esperado);
  });

  it('⚠️ ORDEM: "accept offer is not available" é negociação, e o "not available" do detalhe é inexistência', () => {
    // The pair the needle order and the anchor exist for: a bare `not
    // available` needle matched BOTH sentences, so walked first it would read
    // a refused offer acceptance as a vanished return — and the importer parks
    // on that.
    const aceite = classificar('error_data', 'Accept offer is not available for this return');
    const detalhe = classificar('error_data', 'The return detail is not available.');

    expect(aceite).toBe(MOTIVO_RECUSA_DEVOLUCAO.negociacaoNaoPermite);
    expect(detalhe).toBe(MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente);
    expect(aceite).not.toBe(detalhe);
  });

  it('qualquer OUTRA frase de `error_data` é null — inclusive a falha passageira do detalhe', () => {
    expect(classificar('error_data', 'Query shop info failed. Please try later.')).toBeNull();
    expect(classificar('error_data', 'Query contact info failed. Please try later.')).toBeNull();
    expect(classificar('error_data', 'Cannot accept your own offer.')).toBeNull();
    expect(classificar('error_data', null)).toBeNull();
    expect(classificar('error_data', '')).toBeNull();
  });

  it('near-miss de agulha: frases PARECIDAS não casam', () => {
    // `missing evidence` without `initial`, a return that DOES exist, a review
    // by someone other than Shopee — each one word off a row.
    expect(classificar('error_data', 'The return case is missing evidence')).toBeNull();
    expect(classificar('error_data', 'The return you queried exists')).toBeNull();
    expect(classificar('error_data', 'The seller is reviewing the case')).toBeNull();
    expect(classificar('error_data', 'Valid return status: CLOSED')).toBeNull();
  });

  it('QUASE-IGUAL: um "not available" PASSAGEIRO não é inexistência — a agulha é ancorada no detalhe', () => {
    // R3 F2: the bare needle read this transient as a vanished return — the
    // importer PARKED the delivery and the estado route answered 404.
    for (const transiente of [
      'Service is temporarily not available, please try later.',
      'The service is not available now.',
      'Return list is not available.',
      'The return is not available.',
      'Detail is not available.',
    ]) {
      expect(classificar('error_data', transiente), transiente).toBeNull();
    }
    // …and the anchored sentence still is, through the sentence fold.
    expect(classificar('error_data', 'The return detail is not available.')).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente,
    );
    expect(
      classificar('error_data', 'Wrong parameters, detail:  THE RETURN DETAIL IS NOT AVAILABLE..'),
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente);
  });

  it('`err_data` (sic) e `error_data` NÃO são o mesmo código — o par que a tabela separa', () => {
    // The same sentence under the two spellings: the code alone decides
    // `err_data`, and that sentence is no `error_data` needle.
    expect(classificar('err_data', 'Cannot accept your own offer.')).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.propostaPropria,
    );
    expect(classificar('error_data', 'Cannot accept your own offer.')).toBeNull();
  });
});

describe('classificarRecusaDevolucaoShopee — o escopo das DOBRAS (o que é igual, o que fica distinto)', () => {
  it('IGUAL: um segmento de módulo e brancos nas pontas do código', () => {
    expect(classificar('returns.error_return_status', null)).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite,
    );
    expect(classificar(' error_validation', null)).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.validacaoPeloArmazem,
    );
    expect(classificar('error_validation\t', null)).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.validacaoPeloArmazem,
    );
    expect(classificar('returns.error_data', 'Invalid return status: REQUESTED')).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.statusNaoPermite,
    );
  });

  it('IGUAL: a frase com o prefixo do envelope, em maiúsculas, com brancos e pontos a mais', () => {
    expect(
      classificar('error_data', "Wrong parameters, detail: The return you queried doesn't exist.."),
    ).toBe(MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente);
    expect(classificar('error_data', '  SHOPEE IS   REVIEWING the case.  ')).toBe(
      MOTIVO_RECUSA_DEVOLUCAO.emAnalisePelaShopee,
    );
  });

  it.each([
    ['Error_Return_Status', 'a CAIXA é mantida'],
    ['ERROR_PARAM', 'a CAIXA é mantida'],
    ['error_return_status_x', 'um código MAIS LONGO'],
    ['x.returns.error_return_status', 'exatamente UM segmento, nunca uma remoção gulosa'],
    ['number.error', 'a remoção cai em `error`, que não é chave'],
    ['return.status.illegal', 'um código pontuado do `dispute`, adiado (R-5)'],
    ['error', 'o prefixo sozinho'],
    ['err', 'o prefixo sozinho'],
    ['rraoc', 'o prefixo sozinho'],
    ['constructor', 'protótipo'],
    ['__proto__', 'protótipo'],
    ['toString', 'protótipo'],
    ['hasOwnProperty', 'protótipo'],
  ])('DISTINTO: `%s` ⇒ null (%s)', (codigo) => {
    expect(classificar(codigo, 'The return status cannot support this action')).toBeNull();
  });

  it('`error_permission` NUNCA é inexistência — nem com a frase da inexistência (as agulhas só valem sob `error_data`)', () => {
    expect(
      classificar('error_permission', "You don't have permission to view this return data."),
    ).toBeNull();
    expect(classificar('error_permission', "The return you queried doesn't exist.")).toBeNull();
    expect(classificar('error_permission', 'The return detail is not available.')).toBeNull();
  });

  it('o limite de taxa não é uma recusa', () => {
    expect(classificar('error_rate_limit', 'too many requests')).toBeNull();
  });
});

describe('classificarRecusaDevolucaoShopee — lê `providerMessage`, NUNCA `err.message`', () => {
  it('a agulha só na NOSSA frase formatada não casa', () => {
    // The thrown sentence is ours; a needle matched on it proves nothing. Here
    // it carries the inexistence sentence while Shopee said nothing at all.
    const err = new ShopeeApiError(
      `Shopee ${SHOPEE_GET_RETURN_DETAIL_PATH} respondeu error_data (HTTP 200) — The return you queried doesn't exist.`,
      {
        code: 'error_data',
        kind: SHOPEE_ERROR_KIND.other,
        httpStatus: 200,
        path: SHOPEE_GET_RETURN_DETAIL_PATH,
        providerMessage: null,
      },
    );

    expect(err.message).toContain("doesn't exist");
    expect(classificarRecusaDevolucaoShopee(err)).toBeNull();
  });

  it('…e a frase da Shopee decide mesmo quando a nossa diz outra coisa', () => {
    const err = new ShopeeApiError('Shopee respondeu error_data (HTTP 200)', {
      code: 'error_data',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: SHOPEE_GET_RETURN_DETAIL_PATH,
      providerMessage: 'Shopee is reviewing the case and will get back to you.',
    });

    expect(err.message).not.toContain('reviewing');
    expect(classificarRecusaDevolucaoShopee(err)).toBe(MOTIVO_RECUSA_DEVOLUCAO.emAnalisePelaShopee);
  });

  it('o caminho `/returns/…` na nossa frase não vira agulha', () => {
    // `get_available_solutions` and `accept_offer` put `available` / `offer` in
    // the formatted message before Shopee has said a word.
    const err = doEnvelope('error_data', 'Something unexpected', SHOPEE_RETURN_ACCEPT_OFFER_PATH);

    expect(err.message).toContain('accept_offer');
    expect(classificarRecusaDevolucaoShopee(err)).toBeNull();
  });
});

describe('CODIGOS_DA_RECUSA_DEVOLUCAO — o pino ESTRUTURAL (R-6)', () => {
  it('toda chave começa por `error_`, `err_` ou `rraoc_`, e nenhuma tem ponto', () => {
    // What keeps a one-segment strip from ever landing on a key: `number.error`
    // folds to `error`, and no key may be that short or that bare.
    expect(CODIGOS_DA_RECUSA_DEVOLUCAO.length).toBeGreaterThan(0);
    for (const codigo of CODIGOS_DA_RECUSA_DEVOLUCAO) {
      expect(codigo).toMatch(/^(error_|err_|rraoc_)[a-z0-9_]+$/);
      expect(codigo).not.toContain('.');
    }
  });

  it('é EXATAMENTE o que o classificador lê: dez códigos, sem repetição, `error_data` entre eles', () => {
    expect([...CODIGOS_DA_RECUSA_DEVOLUCAO].sort()).toEqual(
      [
        'err_data',
        'error_data',
        'error_negotiation_status',
        'error_no_buyer_offer',
        'error_ongoing_dispute',
        'error_param',
        'error_return_request_type',
        'error_return_status',
        'error_validation',
        'rraoc_refund_not_allowed',
      ].sort(),
    );
    expect(new Set(CODIGOS_DA_RECUSA_DEVOLUCAO).size).toBe(CODIGOS_DA_RECUSA_DEVOLUCAO.length);
  });

  it('a lista não é uma cópia: todo código dela é lido (com a frase certa quando é `error_data`)', () => {
    for (const codigo of CODIGOS_DA_RECUSA_DEVOLUCAO) {
      const frase = codigo === 'error_data' ? 'Shopee is reviewing the case.' : null;
      expect(classificar(codigo, frase), codigo).not.toBeNull();
    }
  });

  it('é congelada — um consumidor não consegue alargá-la em tempo de execução', () => {
    expect(Object.isFrozen(CODIGOS_DA_RECUSA_DEVOLUCAO)).toBe(true);
  });
});

describe('o CÓDIGO da Shopee em `devolucoes/` — só pela dobra do classificador ou pelo `codigoSeguro` (R3 F3)', () => {
  /**
   * The app has ONE gate for a Shopee code reaching a log or a CLI
   * (`nfe/redacaoNfe.ts`'s `codigoSeguro`), and the classifier has ONE fold
   * (`codigoCanonicoShopee`). Every `.code` read in this folder's sources sits
   * directly inside one of the two — a raw `err.code` in a log line is what
   * R3 found at three sites, each green and each commented.
   */
  const PASTA = fileURLToPath(new URL('.', import.meta.url));
  const semComentarios = (fonte: string) =>
    fonte
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
  const fontes = readdirSync(PASTA)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => [f, semComentarios(readFileSync(`${PASTA}${f}`, 'utf8'))] as const);

  it('o scan não é vácuo: o importador, as ações e o classificador leem um `.code`', () => {
    const comCodigo = fontes.filter(([, c]) => /\.code\b/.test(c)).map(([f]) => f);
    expect(comCodigo).toEqual(
      expect.arrayContaining(['acoesDevolucao.ts', 'importarDevolucao.ts', 'recusaDevolucao.ts']),
    );
  });

  it('todo `.code` lido está DENTRO de `codigoSeguro(…)` ou `codigoCanonicoShopee(…)`', () => {
    for (const [f, codigo] of fontes) {
      for (const m of codigo.matchAll(/[\w$]+\.code\b/g)) {
        const antes = codigo.slice(0, m.index).trimEnd();
        expect(
          /(?:codigoSeguro|codigoCanonicoShopee)\($/.test(antes),
          `${f}: \`${m[0]}\` fora do portão`,
        ).toBe(true);
      }
    }
  });
});
