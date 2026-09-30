import { describe, expect, it } from 'vitest';
import { formatReais } from '@delfrance/core/money';
import { ESTADO_NFE, estadoNFeSchema } from '../../nfe';
import type { EstadoNFe } from '../../nfe';
import { MODO_LINK_PAGAMENTO, STATUS_LINK_PAGAMENTO } from '../collection/linkPgtoMercadoPago';
import { STATUS_PAGAMENTO, pagamentoSchema } from '../collection/pagamento';
import { ESTADO_PEDIDO } from '../collection/pedido';
import {
  LIMITES_LINK_PAGAMENTO,
  MOTIVO_RECUSA_LINK,
  MOTIVO_RECUSA_LINK_LABELS,
  SITUACAO_LINK_PAGAMENTO,
  SITUACAO_LINK_PAGAMENTO_LABELS,
  disponivelParaNovosLinksCentavos,
  extrairPrimeiroNome,
  linkAtingiuCota,
  linkAtingiuCotaComAprovados,
  mensagemLinksPagamento,
  mensagemQuemJaPagou,
  motivoBloqueioLinkPagamento,
  motivoRecusaLinkSchema,
  pagamentosTravadosPorNFe,
  resumirLinksPagamento,
  situacaoLinkPagamentoSchema,
  valorEmAbertoEmLinks,
  valorEmTransitoForaDeLinksAbertos,
} from './linkPagamento';
import type { LinkPagamentoResumo } from './linkPagamento';

const FUSO = 'America/Sao_Paulo';

/* -------------------------------------------------------------------------- */
/*                                 vocabularies                                */
/* -------------------------------------------------------------------------- */

describe('link vocabularies', () => {
  it('every refusal reason has a constant and a non-empty pt-BR label', () => {
    const opcoes = [...motivoRecusaLinkSchema.options].sort();
    expect(Object.values(MOTIVO_RECUSA_LINK).sort()).toEqual(opcoes);
    expect(Object.keys(MOTIVO_RECUSA_LINK_LABELS).sort()).toEqual(opcoes);
    for (const rotulo of Object.values(MOTIVO_RECUSA_LINK_LABELS)) {
      expect(rotulo.trim().length).toBeGreaterThan(10);
    }
  });

  it('every situação has a constant and a label', () => {
    const opcoes = [...situacaoLinkPagamentoSchema.options].sort();
    expect(Object.values(SITUACAO_LINK_PAGAMENTO).sort()).toEqual(opcoes);
    expect(Object.keys(SITUACAO_LINK_PAGAMENTO_LABELS).sort()).toEqual(opcoes);
  });
});

/* -------------------------------------------------------------------------- */
/*                         motivoBloqueioLinkPagamento                         */
/* -------------------------------------------------------------------------- */

describe('motivoBloqueioLinkPagamento', () => {
  const ok = {
    ehSaida: true,
    estado: ESTADO_PEDIDO.iniciado,
    canalMarketplace: false,
    pagamentosTravadosPorNFe: false,
    restante: 100,
  } as const;

  it('returns null for a saída pedido that can be charged', () => {
    expect(motivoBloqueioLinkPagamento(ok)).toBeNull();
  });

  it('names each blocker on its own', () => {
    expect(motivoBloqueioLinkPagamento({ ...ok, ehSaida: false })).toBe(MOTIVO_RECUSA_LINK.entrada);
    expect(motivoBloqueioLinkPagamento({ ...ok, canalMarketplace: true })).toBe(
      MOTIVO_RECUSA_LINK.canal,
    );
    expect(motivoBloqueioLinkPagamento({ ...ok, estado: ESTADO_PEDIDO.pago })).toBe(
      MOTIVO_RECUSA_LINK.estado,
    );
    expect(motivoBloqueioLinkPagamento({ ...ok, pagamentosTravadosPorNFe: true })).toBe(
      MOTIVO_RECUSA_LINK.nfe,
    );
    expect(motivoBloqueioLinkPagamento({ ...ok, restante: 0 })).toBe(MOTIVO_RECUSA_LINK.semValor);
  });

  it('treats a missing ehSaida as saída (only an explicit false is an entrada)', () => {
    expect(motivoBloqueioLinkPagamento({ ...ok, ehSaida: null })).toBeNull();
    expect(motivoBloqueioLinkPagamento({ ...ok, ehSaida: undefined })).toBeNull();
  });

  it('checks in the documented order: entrada, canal, estado, nfe, semValor', () => {
    const tudoErrado = {
      ehSaida: false,
      estado: ESTADO_PEDIDO.pago,
      canalMarketplace: true,
      pagamentosTravadosPorNFe: true,
      restante: 0,
    };
    expect(motivoBloqueioLinkPagamento(tudoErrado)).toBe(MOTIVO_RECUSA_LINK.entrada);
    expect(motivoBloqueioLinkPagamento({ ...tudoErrado, ehSaida: true })).toBe(
      MOTIVO_RECUSA_LINK.canal,
    );
    expect(
      motivoBloqueioLinkPagamento({ ...tudoErrado, ehSaida: true, canalMarketplace: false }),
    ).toBe(MOTIVO_RECUSA_LINK.estado);
    expect(
      motivoBloqueioLinkPagamento({
        ...tudoErrado,
        ehSaida: true,
        canalMarketplace: false,
        estado: ESTADO_PEDIDO.carrinho,
      }),
    ).toBe(MOTIVO_RECUSA_LINK.nfe);
    expect(
      motivoBloqueioLinkPagamento({
        ehSaida: true,
        canalMarketplace: false,
        estado: ESTADO_PEDIDO.carrinho,
        pagamentosTravadosPorNFe: false,
        restante: 0,
      }),
    ).toBe(MOTIVO_RECUSA_LINK.semValor);
  });

  it('allows every estado podeGerarLinkPagamento allows, and only those', () => {
    for (const estado of Object.values(ESTADO_PEDIDO)) {
      const motivo = motivoBloqueioLinkPagamento({ ...ok, estado });
      expect(motivo === null || motivo === MOTIVO_RECUSA_LINK.estado, estado).toBe(true);
    }
    expect(motivoBloqueioLinkPagamento({ ...ok, estado: ESTADO_PEDIDO.carrinho })).toBeNull();
    expect(motivoBloqueioLinkPagamento({ ...ok, estado: ESTADO_PEDIDO.emAnalise })).toBe(
      MOTIVO_RECUSA_LINK.estado,
    );
  });

  it('semValor below the link minimum (R$ 1,00), not merely at zero', () => {
    // The same floor the route's body schema enforces (valorLinkPagamentoSchema).
    expect(LIMITES_LINK_PAGAMENTO.valorMinimo).toBe(1);
    expect(motivoBloqueioLinkPagamento({ ...ok, restante: 0.004 })).toBe(
      MOTIVO_RECUSA_LINK.semValor,
    );
    expect(motivoBloqueioLinkPagamento({ ...ok, restante: 0.99 })).toBe(
      MOTIVO_RECUSA_LINK.semValor,
    );
    // Exactly the minimum is still a valid link.
    expect(motivoBloqueioLinkPagamento({ ...ok, restante: 1 })).toBeNull();
    expect(motivoBloqueioLinkPagamento({ ...ok, restante: 1.01 })).toBeNull();
  });

  it('semValor for a missing, negative or non-finite restante', () => {
    for (const restante of [null, undefined, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(motivoBloqueioLinkPagamento({ ...ok, restante }), String(restante)).toBe(
        MOTIVO_RECUSA_LINK.semValor,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                          pagamentosTravadosPorNFe                           */
/* -------------------------------------------------------------------------- */

describe('pagamentosTravadosPorNFe', () => {
  /**
   * Spelled out as literals instead of derived from `travarPagamentoComNFe` /
   * `nfeFiscalEncerrada` — re-deriving the expectation from the helpers the rule
   * is built on would only assert `f(x) === f(x)`. Written this way, WIDENING or
   * NARROWING either predicate reds the table below.
   */
  const PEDIDO_COM_EXCECAO = [
    ESTADO_PEDIDO.iniciado,
    ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    ESTADO_PEDIDO.cancelado,
  ] as const;
  const NFE_ENCERRADA = [ESTADO_NFE.cancelada, ESTADO_NFE.numeracaoInutilizada] as const;
  const NFE_QUE_NAO_TRAVA: readonly EstadoNFe[] = [
    ESTADO_NFE.gerado,
    ESTADO_NFE.enviando,
    ESTADO_NFE.aguardandoResposta,
    ESTADO_NFE.processamentoCompleto,
    ESTADO_NFE.processamentoCancelado,
    ESTADO_NFE.epecAprovado,
    ESTADO_NFE.rejeitada,
    ESTADO_NFE.error,
  ];
  const estadosDoPedido = Object.values(ESTADO_PEDIDO);

  it('every NF-e estado is classified by exactly one group above (a new one forces a decision)', () => {
    const classificados = [ESTADO_NFE.aprovada, ...NFE_ENCERRADA, ...NFE_QUE_NAO_TRAVA].sort();
    expect(classificados).toEqual([...estadoNFeSchema.options].sort());
  });

  it('no NF-e → never locked, in any pedido estado', () => {
    for (const estado of estadosDoPedido) {
      expect(pagamentosTravadosPorNFe(null, estado), `null / ${estado}`).toBe(false);
      expect(pagamentosTravadosPorNFe(undefined, estado), `undefined / ${estado}`).toBe(false);
    }
  });

  it('a cancelada / numeração-inutilizada NF-e locks HARD: every pedido estado, carve-outs included', () => {
    for (const nfe of NFE_ENCERRADA) {
      for (const estado of estadosDoPedido) {
        expect(pagamentosTravadosPorNFe(nfe, estado), `${nfe} / ${estado}`).toBe(true);
      }
    }
  });

  it('an aprovada NF-e locks every estado except the three legacy carve-outs', () => {
    for (const estado of estadosDoPedido) {
      const carveOut = (PEDIDO_COM_EXCECAO as readonly string[]).includes(estado);
      expect(pagamentosTravadosPorNFe(ESTADO_NFE.aprovada, estado), estado).toBe(!carveOut);
    }
  });

  it('NEAR-MISS: an aprovada NF-e on a carve-out estado is NOT locked, a cancelada one is', () => {
    for (const estado of PEDIDO_COM_EXCECAO) {
      expect(pagamentosTravadosPorNFe(ESTADO_NFE.aprovada, estado), estado).toBe(false);
      expect(pagamentosTravadosPorNFe(ESTADO_NFE.cancelada, estado), estado).toBe(true);
    }
  });

  it('NEAR-MISS: any other NF-e estado (in flight, rejected, EPEC, error) never locks', () => {
    for (const nfe of NFE_QUE_NAO_TRAVA) {
      for (const estado of estadosDoPedido) {
        expect(pagamentosTravadosPorNFe(nfe, estado), `${nfe} / ${estado}`).toBe(false);
      }
    }
  });

  it('feeds motivoBloqueioLinkPagamento: only a real lock names the nfe reason', () => {
    const base = {
      ehSaida: true,
      canalMarketplace: false,
      restante: 100,
    } as const;
    const motivo = (nfe: EstadoNFe | null, estado: (typeof estadosDoPedido)[number]) =>
      motivoBloqueioLinkPagamento({
        ...base,
        estado,
        pagamentosTravadosPorNFe: pagamentosTravadosPorNFe(nfe, estado),
      });
    // Aprovada on `aguardando…` is the carve-out: the link may still be generated.
    expect(motivo(ESTADO_NFE.aprovada, ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento)).toBeNull();
    // …but not on a `carrinho` (link-eligible, yet outside the carve-outs), nor after a cancelamento.
    expect(motivo(ESTADO_NFE.aprovada, ESTADO_PEDIDO.carrinho)).toBe(MOTIVO_RECUSA_LINK.nfe);
    expect(motivo(ESTADO_NFE.cancelada, ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento)).toBe(
      MOTIVO_RECUSA_LINK.nfe,
    );
    expect(motivo(null, ESTADO_PEDIDO.carrinho)).toBeNull();
    expect(motivo(ESTADO_NFE.rejeitada, ESTADO_PEDIDO.carrinho)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                             extrairPrimeiroNome                             */
/* -------------------------------------------------------------------------- */

describe('extrairPrimeiroNome', () => {
  it.each([
    ['FULANO DA SILVA', 'Fulano'],
    ['maria clara', 'Maria'],
    ['  joão   pedro  ', 'João'],
    ['JOSÉ', 'José'],
    ['José Silva', 'José'], // NFD input is composed first
    ['Ana-Clara Souza', 'Ana-Clara'],
    ['ANA-CLARA', 'Ana-Clara'],
    ["O'BRIEN", "O'brien"],
    ['Zé', 'Zé'],
    ['İSTANBUL', 'İstanbul'],
  ])('%j → %j', (entrada, esperado) => {
    expect(extrairPrimeiroNome(entrada)).toBe(esperado);
  });

  it.each([
    ['a test cardholder in capitals', 'APRO'],
    ['the same in lower case', 'apro'],
    ['the same title-cased', 'Apro'],
    ['a test cardholder followed by a surname', 'OTHE MARIA'],
    ['an e-mail', 'fulano@x.com'],
    ['a CPF', '123.456.789-09'],
    ['a name with a CPF after it', 'MARIA 12345678909'],
    ['a name with one digit', 'João2'],
    ['a single letter', 'A'],
    ['an initial with a dot', 'J.'],
    ['blank', '  '],
    ['empty', ''],
    ['CJK (no case, not Latin)', '山田'],
    ['Arabic', 'محمد'],
    ['an emoji', '😀'],
    ['only punctuation', "'-'"],
    ['ß alone (one letter)', 'ß'],
  ])('rejects %s', (_descricao, entrada) => {
    expect(extrairPrimeiroNome(entrada)).toBeNull();
  });

  it('rejects every Mercado Pago test cardholder name, in any case', () => {
    for (const teste of [
      'APRO',
      'OTHE',
      'CONT',
      'CALL',
      'FUND',
      'SECU',
      'EXPI',
      'FORM',
      'CARD',
      'INST',
      'DUPL',
      'LOCK',
      'CTNA',
      'ATTE',
      'BLAC',
      'UNSU',
    ]) {
      expect(extrairPrimeiroNome(teste), teste).toBeNull();
      expect(extrairPrimeiroNome(teste.toLowerCase()), teste).toBeNull();
    }
  });

  it('compares the whole token: a name that merely starts like a test name survives', () => {
    expect(extrairPrimeiroNome('CONTREIRAS')).toBe('Contreiras');
    expect(extrairPrimeiroNome('Aprigio')).toBe('Aprigio');
    expect(extrairPrimeiroNome('FORMIGA')).toBe('Formiga');
  });

  it('ignores anything that is not a string', () => {
    expect(extrairPrimeiroNome(null)).toBeNull();
    expect(extrairPrimeiroNome(undefined)).toBeNull();
    expect(extrairPrimeiroNome(42)).toBeNull();
    expect(extrairPrimeiroNome({ nome: 'Maria' })).toBeNull();
    expect(extrairPrimeiroNome(['Maria'])).toBeNull();
    expect(extrairPrimeiroNome()).toBeNull();
  });

  it('the first source that yields a name wins; a REJECTED source falls through', () => {
    // A rejected first_name (an e-mail) must not end the search…
    expect(extrairPrimeiroNome('fulano@x.com', 'MARIA SILVA')).toBe('Maria');
    // …nor must a test name, or an absent value.
    expect(extrairPrimeiroNome('APRO', 'Joana Souza')).toBe('Joana');
    expect(extrairPrimeiroNome(null, undefined, 'Ana')).toBe('Ana');
    // …but a source that DOES yield a name wins even when a later one is valid.
    expect(extrairPrimeiroNome('maria clara', 'X Y')).toBe('Maria');
    expect(extrairPrimeiroNome('Beto', 'Carlos Silva')).toBe('Beto');
    // Nothing yields a name.
    expect(extrairPrimeiroNome('a@b.c', 'APRO', '')).toBeNull();
  });

  it('cuts a long name to 20 UTF-16 units and never leaves a dangling hyphen', () => {
    const longo = extrairPrimeiroNome('a'.repeat(30));
    expect(longo).toBe(`A${'a'.repeat(19)}`);
    expect(longo).toHaveLength(20);

    // The cut lands right after the hyphen: it must be stripped, not persisted.
    const cortado = extrairPrimeiroNome(`${'a'.repeat(19)}-bcd`);
    expect(cortado).toBe(`A${'a'.repeat(18)}`);
    expect(cortado?.endsWith('-')).toBe(false);
  });

  it('casing that grows the string still respects the 20 limit and the shape', () => {
    // 'ß' upper-cases to two letters: truncating BEFORE casing would overshoot.
    const sharp = extrairPrimeiroNome('ß'.repeat(30));
    expect(sharp).not.toBeNull();
    expect(sharp?.length).toBeLessThanOrEqual(20);
    expect(sharp?.startsWith('Ss')).toBe(true);
    // 'ŉ' upper-cases to a modifier apostrophe + N — off-shape, so dropped.
    expect(extrairPrimeiroNome('ŉabc')).toBeNull();
  });

  const HOSTIL = [
    'ß'.repeat(30),
    'ß'.repeat(9),
    'ŉ'.repeat(12),
    'ǆǆǆǆ',
    'ªª',
    'ʰʰʰ',
    'ⅷⅷ',
    '😀😀😀😀',
    '😀 João',
    '𝐀𝐁𝐂𝐃',
    '\uD83Dabc',
    '\uD800\uD800',
    '山田太郎',
    'محمد علي',
    'ｆｕｌａｎｏ',
    'İİİİİ',
    'a'.repeat(100_000),
    `a${'́'.repeat(50)}`,
    'á'.repeat(30),
    '---',
    "'''",
    "-a-'b'-",
    "a--b''c",
    'Ana-',
    '-Ana',
    '​maria',
    'ma‍ria',
    'MARIA\u0000',
    'Ａlice',
    'ÑANDÚ',
    'Æsir',
    'ǅuro',
    'ŒUVRE',
    'ıı',
    'ſſ',
    'KK',
  ];

  it('never throws, and every output is null or a well-formed, schema-valid first name', () => {
    const forma = /^\p{Lu}[\p{Ll}\p{M}']*(?:-\p{Lu}[\p{Ll}\p{M}']*)*$/u;
    for (const entrada of HOSTIL) {
      const nome = extrairPrimeiroNome(entrada);
      if (nome === null) continue;
      expect(nome, JSON.stringify(entrada)).toMatch(forma);
      expect(nome.length, JSON.stringify(entrada)).toBeGreaterThanOrEqual(2);
      expect(nome.length, JSON.stringify(entrada)).toBeLessThanOrEqual(20);
      // The persisted field's own schema: what the reconcile transaction will run.
      expect(
        pagamentoSchema.shape.primeiroNomePagador.safeParse(nome).success,
        JSON.stringify(entrada),
      ).toBe(true);
    }
  });

  it('the hostile table is not vacuous: some entries do produce a name', () => {
    const nomes = HOSTIL.map((h) => extrairPrimeiroNome(h)).filter((n) => n !== null);
    expect(nomes.length).toBeGreaterThan(5);
    expect(HOSTIL.some((h) => extrairPrimeiroNome(h) === null)).toBe(true);
  });

  it('caps a stack of combining marks', () => {
    const nome = extrairPrimeiroNome(`a${'́'.repeat(50)}bc`);
    // 'á' composes; at most two further marks survive.
    expect(nome).not.toBeNull();
    expect(nome?.length).toBeLessThanOrEqual(6);
  });
});

/* -------------------------------------------------------------------------- */
/*                                linkAtingiuCota                              */
/* -------------------------------------------------------------------------- */

describe('linkAtingiuCota', () => {
  const aprovado = { dataAprovacao: 1_727_000_000_000_000 };
  const pendente = { dataAprovacao: null };
  const individual = MODO_LINK_PAGAMENTO.individual;
  const compartilhado = MODO_LINK_PAGAMENTO.compartilhado;

  it('is true once as many payments were approved as the quota', () => {
    expect(linkAtingiuCota({ modo: individual, quantidadeMaxima: 1 }, [aprovado])).toBe(true);
    expect(
      linkAtingiuCota({ modo: compartilhado, quantidadeMaxima: 3 }, [aprovado, aprovado, aprovado]),
    ).toBe(true);
  });

  it('is false one payment short (the near-miss of >=)', () => {
    expect(linkAtingiuCota({ modo: individual, quantidadeMaxima: 1 }, [])).toBe(false);
    expect(
      linkAtingiuCota({ modo: compartilhado, quantidadeMaxima: 3 }, [aprovado, aprovado]),
    ).toBe(false);
  });

  it('counts approvals only: pending payments do not use up a slot', () => {
    expect(linkAtingiuCota({ modo: individual, quantidadeMaxima: 1 }, [pendente])).toBe(false);
    expect(
      linkAtingiuCota({ modo: compartilhado, quantidadeMaxima: 2 }, [aprovado, pendente, {}]),
    ).toBe(false);
  });

  it('is >= not ===: an over-full link is still full', () => {
    expect(linkAtingiuCota({ modo: individual, quantidadeMaxima: 1 }, [aprovado, aprovado])).toBe(
      true,
    );
  });

  it('reads a TRACEABLE link with no stored quota as accepting ONE payment', () => {
    for (const quantidadeMaxima of [null, undefined]) {
      const link = { modo: individual, quantidadeMaxima };
      expect(linkAtingiuCota(link, [aprovado]), String(quantidadeMaxima)).toBe(true);
      // Near-miss: with nothing approved the same link is still open.
      expect(linkAtingiuCota(link, []), String(quantidadeMaxima)).toBe(false);
    }
  });

  it('never closes a LEGACY link (no readable modo), even one that stores a quota', () => {
    for (const modo of [null, undefined, 'lixo']) {
      expect(linkAtingiuCota({ modo, quantidadeMaxima: null }, [aprovado, aprovado])).toBe(false);
      expect(linkAtingiuCota({ modo, quantidadeMaxima: 1 }, [aprovado, aprovado])).toBe(false);
    }
    expect(linkAtingiuCota({}, [aprovado])).toBe(false);
  });

  it('uses the SAME quota the summary shows, for every stored quantidadeMaxima', () => {
    // A quota that is not an integer >= 1 is no quota — for a traceable link, 1.
    for (const quantidadeMaxima of [null, 0, -2, 1.5, 1, 3]) {
      const [resumo] = resumirLinksPagamento({
        links: [{ id: 'l', data: { modo: compartilhado, quantidadeMaxima } }],
        pagamentos: [],
        agoraMs: 0,
      });
      const cota = resumo!.quantidadeMaxima!;
      const link = { modo: compartilhado, quantidadeMaxima };
      const aprovados = (n: number) => Array.from({ length: n }, () => aprovado);
      expect(linkAtingiuCota(link, aprovados(cota)), String(quantidadeMaxima)).toBe(true);
      expect(linkAtingiuCota(link, aprovados(cota - 1)), String(quantidadeMaxima)).toBe(false);
    }
  });
});

describe('linkAtingiuCotaComAprovados', () => {
  const individual = MODO_LINK_PAGAMENTO.individual;

  it('is the count form of the SAME rule', () => {
    for (const quantidadeMaxima of [null, 1, 2, 5]) {
      for (let n = 0; n <= 6; n += 1) {
        const link = { modo: individual, quantidadeMaxima };
        const linhas = Array.from({ length: n }, () => ({ dataAprovacao: 1 }));
        expect(linkAtingiuCotaComAprovados(link, n), `${quantidadeMaxima}/${n}`).toBe(
          linkAtingiuCota(link, linhas),
        );
      }
    }
  });

  it('leaves the link open when the count is not a number', () => {
    expect(linkAtingiuCotaComAprovados({ modo: individual, quantidadeMaxima: 1 }, Number.NaN)).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                            resumirLinksPagamento                            */
/* -------------------------------------------------------------------------- */

describe('resumirLinksPagamento', () => {
  const ID_A = 'AAAAAAAAAAAAAAAAAAAA';
  const ID_B = 'BBBBBBBBBBBBBBBBBBBB';
  const ID_C = 'CCCCCCCCCCCCCCCCCCCC';
  const AGORA = 1_727_000_000_000; // ms
  const APROVADO_US = 1_727_000_000_000_000; // µs — pagamento dates are microseconds

  function link(id: string, sobre: Record<string, unknown> = {}) {
    return {
      id,
      data: {
        contaMercadoPagoOuterRef: 'documents/metodo_pgto/conta1',
        valorCobrado: 33.34,
        link: `https://mp.example/${id}`,
        id: `pref-${id}`,
        dataCriacao: 1_000,
        dataExpiracao: AGORA + 60_000,
        modo: MODO_LINK_PAGAMENTO.individual,
        nomePagador: 'Maria',
        quantidadeMaxima: 1,
        grupoId: 'grupo1',
        ordem: 0,
        status: STATUS_LINK_PAGAMENTO.aberto,
        ...sobre,
      },
    };
  }

  function pagamento(id: string, sobre: Record<string, unknown> = {}) {
    return {
      id,
      data: {
        valor: 33.34,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        linkPagamentoId: ID_A,
        primeiroNomePagador: 'Mariana',
        dataAprovacao: APROVADO_US,
        ...sobre,
      },
    };
  }

  function resumirUm(
    linkSobre: Record<string, unknown>,
    pagamentos: ReturnType<typeof pagamento>[],
    agoraMs = AGORA,
  ): LinkPagamentoResumo {
    const [resumo] = resumirLinksPagamento({ links: [link(ID_A, linkSobre)], pagamentos, agoraMs });
    if (!resumo) throw new Error('no resumo');
    return resumo;
  }

  it('an individual link with its payment approved reads pago', () => {
    const r = resumirUm({}, [pagamento('p1')]);
    expect(r.situacao).toBe(SITUACAO_LINK_PAGAMENTO.pago);
    expect(r.rastreavel).toBe(true);
    expect(r.pagos).toBe(1);
    expect(r.restantes).toBe(0);
    expect(r.valorRecebido).toBe(33.34);
    // Pagamento dates are µs; the summary speaks ms.
    expect(r.pagantes).toEqual([{ nome: 'Maria', dataAprovacao: 1_727_000_000_000 }]);
  });

  it('carries the link fields through (ids, account, url, dates in ms)', () => {
    const r = resumirUm({ dataExpiracao: 1_727_000_060_000_000 /* µs */ }, []);
    expect(r).toMatchObject({
      linkId: ID_A,
      modo: MODO_LINK_PAGAMENTO.individual,
      valor: 33.34,
      nomePagador: 'Maria',
      quantidadeMaxima: 1,
      pagos: 0,
      restantes: 1,
      valorRecebido: 0,
      pagantes: [],
      situacao: SITUACAO_LINK_PAGAMENTO.aberto,
      dataExpiracaoMs: 1_727_000_060_000, // µs input normalised to ms
      link: `https://mp.example/${ID_A}`,
      contaId: 'conta1',
      preferenceId: `pref-${ID_A}`,
      status: STATUS_LINK_PAGAMENTO.aberto,
      ordem: 0,
      grupoId: 'grupo1',
      dataCriacaoMs: 1_000,
    });
  });

  describe('attribution', () => {
    it('a pending or refused attributed payment is not a payment', () => {
      for (const status of [
        STATUS_PAGAMENTO.pendente,
        STATUS_PAGAMENTO.recusado,
        STATUS_PAGAMENTO.cancelado,
      ]) {
        const r = resumirUm({}, [pagamento('p1', { status_pagamento: status })]);
        expect(r.pagos, String(status)).toBe(0);
        expect(r.valorRecebido, String(status)).toBe(0);
        expect(r.pagantes, String(status)).toEqual([]);
        expect(r.situacao, String(status)).toBe(SITUACAO_LINK_PAGAMENTO.aberto);
      }
      // The near-miss of the row above: the same row approved DOES count.
      expect(resumirUm({}, [pagamento('p1')]).pagos).toBe(1);
    });

    it('a payment refunded after approval no longer counts', () => {
      const r = resumirUm({ quantidadeMaxima: 2, modo: MODO_LINK_PAGAMENTO.compartilhado }, [
        pagamento('p1'),
        pagamento('p2', { status_pagamento: STATUS_PAGAMENTO.estornado }),
      ]);
      expect(r.pagos).toBe(1);
      expect(r.situacao).toBe(SITUACAO_LINK_PAGAMENTO.parcial);
    });

    it('a payment attributed to ANOTHER link is not counted', () => {
      const r = resumirUm({}, [pagamento('p1', { linkPagamentoId: ID_B })]);
      expect(r.pagos).toBe(0);
      expect(r.situacao).toBe(SITUACAO_LINK_PAGAMENTO.aberto);
    });

    it('an unattributed payment (manual, legacy) belongs to no link', () => {
      const r = resumirUm({}, [
        pagamento('p1', { linkPagamentoId: undefined }),
        pagamento('p2', { linkPagamentoId: null }),
        pagamento('p3', { linkPagamentoId: '' }),
      ]);
      expect(r.pagos).toBe(0);
    });

    it('matches on the link DOC id, never on the preference id stored in its `id` field', () => {
      // Link A carries, as its preference id, a string equal to link B's doc id.
      // A payment attributed to B must credit B and only B.
      const resultado = resumirLinksPagamento({
        links: [link(ID_A, { id: ID_B }), link(ID_B, { id: 'pref-b', ordem: 1 })],
        pagamentos: [pagamento('p1', { linkPagamentoId: ID_B })],
        agoraMs: AGORA,
      });
      const a = resultado.find((r) => r.linkId === ID_A);
      const b = resultado.find((r) => r.linkId === ID_B);
      expect(a?.pagos).toBe(0);
      expect(a?.situacao).toBe(SITUACAO_LINK_PAGAMENTO.aberto);
      expect(a?.preferenceId).toBe(ID_B);
      expect(b?.pagos).toBe(1);
      expect(b?.situacao).toBe(SITUACAO_LINK_PAGAMENTO.pago);
    });

    it('one payment is credited to exactly one link', () => {
      const resultado = resumirLinksPagamento({
        links: [link(ID_A), link(ID_B, { ordem: 1 })],
        pagamentos: [pagamento('p1', { linkPagamentoId: ID_A })],
        agoraMs: AGORA,
      });
      expect(resultado.map((r) => r.pagos)).toEqual([1, 0]);
    });
  });

  describe('situação', () => {
    it('paid AFTER cancellation still reads pago (a PUT-expire may not stop a Pix)', () => {
      const r = resumirUm({ status: STATUS_LINK_PAGAMENTO.cancelado }, [pagamento('p1')]);
      expect(r.situacao).toBe(SITUACAO_LINK_PAGAMENTO.pago);
      expect(r.status).toBe(STATUS_LINK_PAGAMENTO.cancelado); // the stored status is untouched
      expect(r.valorRecebido).toBe(33.34);
    });

    it('cancelled with nothing paid reads cancelado — even when it is also expired', () => {
      const r = resumirUm(
        { status: STATUS_LINK_PAGAMENTO.cancelado, dataExpiracao: AGORA - 1 },
        [],
      );
      expect(r.situacao).toBe(SITUACAO_LINK_PAGAMENTO.cancelado);
    });

    it('an auto-closed link (concluido) whose payment still counts reads pago', () => {
      const r = resumirUm({ status: STATUS_LINK_PAGAMENTO.concluido }, [pagamento('p1')]);
      expect(r).toMatchObject({ situacao: SITUACAO_LINK_PAGAMENTO.pago, pagos: 1 });
    });

    it('a payment in dispute still counts: the concluido link stays pago', () => {
      const r = resumirUm({ status: STATUS_LINK_PAGAMENTO.concluido }, [
        pagamento('p1', { status_pagamento: STATUS_PAGAMENTO.em_disputa }),
      ]);
      expect(r.situacao).toBe(SITUACAO_LINK_PAGAMENTO.pago);
    });

    it('⚠️ NEAR-MISS: the same concluido link whose payment went back reads estornado, never pago', () => {
      // Auto-closed on the approval (`linkAtingiuCota` counts EVER-approved), then
      // refunded or charged back: MP keeps `date_approved`, the row stops paying.
      for (const status of [
        STATUS_PAGAMENTO.estornado,
        STATUS_PAGAMENTO.estornado_totalmente,
        STATUS_PAGAMENTO.devolvido,
      ]) {
        const r = resumirUm({ status: STATUS_LINK_PAGAMENTO.concluido }, [
          pagamento('p1', { status_pagamento: status }),
        ]);
        expect(r, String(status)).toMatchObject({
          situacao: SITUACAO_LINK_PAGAMENTO.estornado,
          pagos: 0,
          valorRecebido: 0,
          pagantes: [],
        });
      }
    });

    it('a shared link closed at its quota with ONE refund reads estornado, keeping the rest', () => {
      const r = resumirUm(
        {
          modo: MODO_LINK_PAGAMENTO.compartilhado,
          quantidadeMaxima: 3,
          status: STATUS_LINK_PAGAMENTO.concluido,
        },
        [
          pagamento('p1'),
          pagamento('p2'),
          pagamento('p3', { status_pagamento: STATUS_PAGAMENTO.estornado }),
        ],
      );
      expect(r).toMatchObject({
        situacao: SITUACAO_LINK_PAGAMENTO.estornado,
        pagos: 2,
        restantes: 1,
      });
    });

    it('a concluido link with no paying row at all is not pago either', () => {
      expect(resumirUm({ status: STATUS_LINK_PAGAMENTO.concluido }, []).situacao).toBe(
        SITUACAO_LINK_PAGAMENTO.estornado,
      );
    });

    it('expiry is STRICT: at the exact instant the link is still open', () => {
      expect(resumirUm({ dataExpiracao: AGORA }, [], AGORA).situacao).toBe(
        SITUACAO_LINK_PAGAMENTO.aberto,
      );
      expect(resumirUm({ dataExpiracao: AGORA - 1 }, [], AGORA).situacao).toBe(
        SITUACAO_LINK_PAGAMENTO.expirado,
      );
      expect(resumirUm({ dataExpiracao: AGORA + 1 }, [], AGORA).situacao).toBe(
        SITUACAO_LINK_PAGAMENTO.aberto,
      );
    });

    it('an expired link that was paid reads pago, not expirado', () => {
      const r = resumirUm({ dataExpiracao: AGORA - 1 }, [pagamento('p1')]);
      expect(r.situacao).toBe(SITUACAO_LINK_PAGAMENTO.pago);
    });

    it('a shared link is parcial until its last payment makes it pago', () => {
      const compartilhado = { modo: MODO_LINK_PAGAMENTO.compartilhado, quantidadeMaxima: 3 };
      const parcial = SITUACAO_LINK_PAGAMENTO.parcial;
      const um = resumirUm(compartilhado, [pagamento('p1')]);
      expect(um).toMatchObject({ pagos: 1, restantes: 2, situacao: parcial });
      const dois = resumirUm(compartilhado, [pagamento('p1'), pagamento('p2')]);
      expect(dois).toMatchObject({ pagos: 2, restantes: 1, situacao: parcial });
      const tres = resumirUm(compartilhado, [pagamento('p1'), pagamento('p2'), pagamento('p3')]);
      expect(tres).toMatchObject({
        pagos: 3,
        restantes: 0,
        situacao: SITUACAO_LINK_PAGAMENTO.pago,
      });
    });

    it('a partly paid link that expires reads expirado (the quota is unmet)', () => {
      const r = resumirUm(
        { modo: MODO_LINK_PAGAMENTO.compartilhado, quantidadeMaxima: 3, dataExpiracao: AGORA - 1 },
        [pagamento('p1')],
      );
      expect(r.situacao).toBe(SITUACAO_LINK_PAGAMENTO.expirado);
      expect(r.pagos).toBe(1);
    });

    it('a traceable link with no stored quota defaults to one payment', () => {
      const r = resumirUm({ quantidadeMaxima: null }, []);
      expect(r.quantidadeMaxima).toBe(1);
      expect(r.restantes).toBe(1);
    });
  });

  describe('legacy links (written by the Flutter app)', () => {
    const legado = {
      modo: undefined,
      nomePagador: undefined,
      quantidadeMaxima: undefined,
      grupoId: undefined,
      ordem: undefined,
      status: undefined,
    };

    it('reads legado: not traceable, no quota, nothing to count', () => {
      const r = resumirUm(legado, []);
      expect(r).toMatchObject({
        modo: null,
        rastreavel: false,
        situacao: SITUACAO_LINK_PAGAMENTO.legado,
        quantidadeMaxima: null,
        restantes: null,
        pagos: 0,
        status: null,
        nomePagador: null,
        ordem: null,
        grupoId: null,
      });
    });

    it('stays legado whatever the dates and payments say', () => {
      expect(resumirUm({ ...legado, dataExpiracao: AGORA - 1 }, []).situacao).toBe(
        SITUACAO_LINK_PAGAMENTO.legado,
      );
      expect(resumirUm(legado, [pagamento('p1')]).situacao).toBe(SITUACAO_LINK_PAGAMENTO.legado);
      expect(resumirUm(legado, [pagamento('p1')]).rastreavel).toBe(false);
    });

    it('a parsed legacy doc (defaults filled in) is still legado', () => {
      const r = resumirUm({ ...legado, status: STATUS_LINK_PAGAMENTO.aberto, modo: null }, []);
      expect(r.rastreavel).toBe(false);
      expect(r.situacao).toBe(SITUACAO_LINK_PAGAMENTO.legado);
    });
  });

  describe('pagantes', () => {
    it('are the paying rows only, oldest approval first, with a missing date last', () => {
      const r = resumirUm({ modo: MODO_LINK_PAGAMENTO.compartilhado, quantidadeMaxima: 5 }, [
        pagamento('p3', { primeiroNomePagador: 'Sem data', dataAprovacao: null }),
        pagamento('p2', { primeiroNomePagador: 'Beto', dataAprovacao: APROVADO_US + 2_000_000 }),
        pagamento('p1', { primeiroNomePagador: 'Ana', dataAprovacao: APROVADO_US }),
        pagamento('px', {
          primeiroNomePagador: 'Recusada',
          status_pagamento: STATUS_PAGAMENTO.recusado,
        }),
      ]);
      expect(r.pagantes.map((p) => p.nome)).toEqual(['Ana', 'Beto', 'Sem data']);
      expect(r.pagantes.map((p) => p.dataAprovacao)).toEqual([
        1_727_000_000_000,
        1_727_000_002_000,
        null,
      ]);
    });

    it('a SHARED link names payers by the cardholder only; missing → null', () => {
      const r = resumirUm(
        { modo: MODO_LINK_PAGAMENTO.compartilhado, quantidadeMaxima: 3, nomePagador: 'Rótulo' },
        [
          pagamento('p1', { primeiroNomePagador: 'Ana' }),
          pagamento('p2', {
            primeiroNomePagador: undefined,
            dataAprovacao: APROVADO_US + 1_000_000,
          }),
        ],
      );
      expect(r.pagantes.map((p) => p.nome)).toEqual(['Ana', null]);
    });

    it('an INDIVIDUAL link is named by the operator label first, the cardholder second', () => {
      const comRotulo = resumirUm({ nomePagador: 'Maria' }, [
        pagamento('p1', { primeiroNomePagador: 'Mariana' }),
      ]);
      expect(comRotulo.pagantes[0]?.nome).toBe('Maria');
      const semRotulo = resumirUm({ nomePagador: null }, [
        pagamento('p1', { primeiroNomePagador: 'Mariana' }),
      ]);
      expect(semRotulo.pagantes[0]?.nome).toBe('Mariana');
      const semNada = resumirUm({ nomePagador: null }, [
        pagamento('p1', { primeiroNomePagador: undefined }),
      ]);
      expect(semNada.pagantes[0]?.nome).toBeNull();
    });

    it('valorRecebido sums only the paying attributed rows', () => {
      const r = resumirUm({ modo: MODO_LINK_PAGAMENTO.compartilhado, quantidadeMaxima: 5 }, [
        pagamento('p1', { valor: 10.1 }),
        pagamento('p2', { valor: 20.2 }),
        pagamento('p3', { valor: 99, status_pagamento: STATUS_PAGAMENTO.pendente }),
        pagamento('p4', { valor: 99, linkPagamentoId: ID_B }),
      ]);
      expect(r.valorRecebido).toBe(30.3);
    });
  });

  describe('ordering', () => {
    it('orders by ordem ascending, then newest first; missing ordem sorts last', () => {
      const resultado = resumirLinksPagamento({
        links: [
          link(ID_C, { ordem: null, dataCriacao: 9_000 }),
          link(ID_B, { ordem: 1, dataCriacao: 1_000 }),
          link('DDDDDDDDDDDDDDDDDDDD', { ordem: 0, dataCriacao: 1_000 }),
          link(ID_A, { ordem: 0, dataCriacao: 2_000 }),
        ],
        pagamentos: [],
        agoraMs: AGORA,
      });
      expect(resultado.map((r) => r.linkId)).toEqual([
        ID_A, // ordem 0, newer
        'DDDDDDDDDDDDDDDDDDDD', // ordem 0, older
        ID_B, // ordem 1
        ID_C, // no ordem
      ]);
    });

    it('is stable for full ties', () => {
      const resultado = resumirLinksPagamento({
        links: [link(ID_B, { ordem: 0 }), link(ID_A, { ordem: 0 })],
        pagamentos: [],
        agoraMs: AGORA,
      });
      expect(resultado.map((r) => r.linkId)).toEqual([ID_B, ID_A]);
    });
  });

  describe('raw, malformed rows (a failed soft-read returns the raw doc)', () => {
    it('never throws and degrades each field to null / a safe default', () => {
      const lixo: unknown[] = [null, undefined, 42, 'texto', [], [1, 2], true, {}];
      const linkMalformado = {
        modo: 'inexistente',
        status: 7,
        valorCobrado: 'caro',
        link: 42,
        id: {},
        contaMercadoPagoOuterRef: 'sem-barra',
        dataExpiracao: 'não é data',
        dataCriacao: -1e300,
        quantidadeMaxima: 'muitos',
        ordem: -3,
        nomePagador: '   ',
      };
      const resultado = resumirLinksPagamento({
        links: [
          ...lixo.map((data, i) => ({ id: `L${i}`, data })),
          { id: 'LX', data: linkMalformado },
        ],
        pagamentos: [
          ...lixo.map((data, i) => ({ id: `P${i}`, data })),
          { id: 'PX', data: { linkPagamentoId: 12345, valor: 'x', status_pagamento: 'y' } },
          { id: 'PY', data: { linkPagamentoId: 'LX', valor: 'x', status_pagamento: 'y' } },
          { id: 'PZ', data: { linkPagamentoId: 'LX', valor: -5, dataAprovacao: 'lixo' } },
        ],
        agoraMs: AGORA,
      });
      expect(resultado).toHaveLength(lixo.length + 1);
      const lx = resultado.find((r) => r.linkId === 'LX');
      expect(lx).toMatchObject({
        modo: null,
        rastreavel: false,
        valor: 0,
        link: null,
        preferenceId: null,
        contaId: 'sem-barra',
        dataExpiracaoMs: null,
        dataCriacaoMs: null,
        quantidadeMaxima: null,
        ordem: null,
        nomePagador: null,
        status: null,
        situacao: SITUACAO_LINK_PAGAMENTO.legado,
      });
      // PY has a corrupt status → skipped; PZ has none → counts as paid, value clamped to 0.
      expect(lx?.pagos).toBe(1);
      expect(lx?.valorRecebido).toBe(0);
      expect(lx?.pagantes).toEqual([{ nome: null, dataAprovacao: null }]);
    });

    it('a date far outside any real range is dropped, so the copy text can format the rest', () => {
      // 9e99 and 5e17 are read as µs → ms far beyond the year 9999.
      const r = resumirUm({ dataExpiracao: 9e99, dataCriacao: 5e17 }, []);
      expect(r.dataExpiracaoMs).toBeNull();
      expect(r.dataCriacaoMs).toBeNull();
      expect(r.situacao).toBe(SITUACAO_LINK_PAGAMENTO.aberto);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                            valorEmAbertoEmLinks                             */
/* -------------------------------------------------------------------------- */

function resumo(sobre: Partial<LinkPagamentoResumo> = {}): LinkPagamentoResumo {
  return {
    linkId: 'L1',
    modo: MODO_LINK_PAGAMENTO.individual,
    rastreavel: true,
    valor: 33.34,
    nomePagador: 'Maria',
    quantidadeMaxima: 1,
    pagos: 0,
    restantes: 1,
    valorRecebido: 0,
    pagantes: [],
    situacao: SITUACAO_LINK_PAGAMENTO.aberto,
    dataExpiracaoMs: null,
    link: 'https://mp.example/a',
    contaId: 'conta1',
    preferenceId: 'pref-1',
    status: STATUS_LINK_PAGAMENTO.aberto,
    ordem: 0,
    grupoId: 'g1',
    dataCriacaoMs: 1_000,
    ...sobre,
  };
}

describe('valorEmAbertoEmLinks', () => {
  it('is 0 for no links', () => {
    expect(valorEmAbertoEmLinks([])).toBe(0);
  });

  it('counts an open individual link once', () => {
    expect(valorEmAbertoEmLinks([resumo()])).toBe(33.34);
  });

  it('counts a shared link once per payment it still accepts', () => {
    const compartilhado = resumo({
      modo: MODO_LINK_PAGAMENTO.compartilhado,
      valor: 50,
      quantidadeMaxima: 3,
      pagos: 1,
      restantes: 2,
      situacao: SITUACAO_LINK_PAGAMENTO.parcial,
    });
    expect(valorEmAbertoEmLinks([compartilhado])).toBe(100);
    // The near-miss: a shared link nobody paid yet counts all three.
    expect(valorEmAbertoEmLinks([{ ...compartilhado, pagos: 0, restantes: 3 }])).toBe(150);
  });

  it('excludes every link that can no longer receive money', () => {
    for (const situacao of [
      SITUACAO_LINK_PAGAMENTO.pago,
      SITUACAO_LINK_PAGAMENTO.cancelado,
      SITUACAO_LINK_PAGAMENTO.expirado,
    ]) {
      expect(valorEmAbertoEmLinks([resumo({ situacao })]), situacao).toBe(0);
    }
  });

  it('excludes LEGACY links: they can never show a payment, so they would block forever', () => {
    const legado = resumo({
      modo: null,
      rastreavel: false,
      quantidadeMaxima: null,
      restantes: null,
      situacao: SITUACAO_LINK_PAGAMENTO.legado,
    });
    expect(valorEmAbertoEmLinks([legado])).toBe(0);
    // Even a hypothetical legacy row that claims to be open is not counted.
    expect(valorEmAbertoEmLinks([{ ...legado, situacao: SITUACAO_LINK_PAGAMENTO.aberto }])).toBe(0);
  });

  it('sums to the cent without float drift', () => {
    const tres = [33.34, 33.33, 33.33].map((valor, i) => resumo({ linkId: `L${i}`, valor }));
    expect(valorEmAbertoEmLinks(tres)).toBe(100);
    const decimais = [0.1, 0.2].map((valor, i) => resumo({ linkId: `L${i}`, valor }));
    expect(valorEmAbertoEmLinks(decimais)).toBe(0.3); // 0.1 + 0.2 !== 0.3 in floats
  });
});

/* -------------------------------------------------------------------------- */
/*      valorEmTransitoForaDeLinksAbertos / disponivelParaNovosLinksCentavos     */
/* -------------------------------------------------------------------------- */

describe('valorEmTransitoForaDeLinksAbertos / disponivelParaNovosLinksCentavos', () => {
  // The ONE "available for new links" rule: the mercado-pago exposure guard refuses
  // above it and the web tab shows it, limits its form and splits by it.
  const AGORA = 1_727_000_000_000; // ms
  const DIA = 86_400_000;

  type Bruto = { id: string; data: unknown };

  /** A stored link, raw: an OPEN individual link of R$ 40,00 unless overridden. */
  function linkBruto(id: string, sobre: Record<string, unknown> = {}): Bruto {
    return {
      id,
      data: {
        modo: MODO_LINK_PAGAMENTO.individual,
        status: STATUS_LINK_PAGAMENTO.aberto,
        valorCobrado: 40,
        quantidadeMaxima: 1,
        dataExpiracao: AGORA + 3 * DIA,
        ...sobre,
      },
    };
  }

  /** A R$ 40,00 pagamento attributed to link `a`, with the given status. */
  function emTransito(status: unknown, sobre: Record<string, unknown> = {}): Bruto {
    return {
      id: 'p1',
      data: { valor: 40, status_pagamento: status, linkPagamentoId: 'a', ...sobre },
    };
  }

  /** Link `a`, expired yesterday — a Pix issued before it lapsed may still land. */
  const expirado = linkBruto('a', { dataExpiracao: AGORA - DIA });

  const PENDENTES = [
    STATUS_PAGAMENTO.pendente,
    STATUS_PAGAMENTO.em_revisao,
    STATUS_PAGAMENTO.em_processo_aprovacao,
  ];

  function calcular(links: Bruto[], pagamentos: Bruto[], restante: number | null = 100) {
    const resumos = resumirLinksPagamento({ links, pagamentos, agoraMs: AGORA });
    return {
      emTransito: valorEmTransitoForaDeLinksAbertos(resumos, pagamentos),
      disponivel: disponivelParaNovosLinksCentavos({ restante, resumos, pagamentos }),
    };
  }

  it('counts every pending status on a link that is no longer open', () => {
    for (const status of PENDENTES) {
      expect(calcular([expirado], [emTransito(status)]), String(status)).toEqual({
        emTransito: 40,
        disponivel: 6_000,
      });
    }
  });

  it('counts nothing for a payment that is final, paying or unreadable (near-miss)', () => {
    for (const status of [
      STATUS_PAGAMENTO.recusado,
      STATUS_PAGAMENTO.cancelado,
      STATUS_PAGAMENTO.estornado,
      STATUS_PAGAMENTO.aprovado,
      'pendente',
      null,
    ]) {
      expect(calcular([expirado], [emTransito(status)]), String(status)).toEqual({
        emTransito: 0,
        disponivel: 10_000,
      });
    }
  });

  it('counts it on a cancelled, concluded, paid or legacy link as on an expired one', () => {
    const naoAbertos: Bruto[] = [
      linkBruto('a', { status: STATUS_LINK_PAGAMENTO.cancelado }),
      linkBruto('a', { status: STATUS_LINK_PAGAMENTO.concluido }),
      // A legacy link (no `modo`) is never open: its attributed pending money is in flight.
      { id: 'a', data: { valorCobrado: 40, dataExpiracao: AGORA + DIA } },
    ];
    for (const link of naoAbertos) {
      expect(calcular([link], [emTransito(STATUS_PAGAMENTO.pendente)]).emTransito).toBe(40);
    }
    // A paid individual link with a SECOND payment still pending on it: only the
    // pending one is in flight (the approved one is money in hand, in `restante`).
    const aprovado: Bruto = {
      id: 'p0',
      data: { valor: 40, status_pagamento: STATUS_PAGAMENTO.aprovado, linkPagamentoId: 'a' },
    };
    const pago = calcular([linkBruto('a')], [aprovado, emTransito(STATUS_PAGAMENTO.pendente)]);
    expect(pago.emTransito).toBe(40);
  });

  it('does NOT double count a pending payment on a link that is still OPEN', () => {
    // The open link's pending payment is already inside valor × restantes (40).
    for (const status of PENDENTES) {
      expect(calcular([linkBruto('a')], [emTransito(status)]), String(status)).toEqual({
        emTransito: 0,
        disponivel: 6_000,
      });
    }
  });

  it('counts nothing for a pending payment that names no STORED link of the pedido', () => {
    for (const linkPagamentoId of [null, 'naoGuardado', 123]) {
      const pendente = emTransito(STATUS_PAGAMENTO.pendente, { linkPagamentoId });
      expect(calcular([expirado], [pendente]).emTransito, String(linkPagamentoId)).toBe(0);
    }
  });

  it('adds nothing for a valor that is not a positive finite number', () => {
    for (const valor of [0, -40, Number.NaN, Number.POSITIVE_INFINITY, '40', null]) {
      const pendente = emTransito(STATUS_PAGAMENTO.pendente, { valor });
      expect(calcular([expirado], [pendente]).emTransito, String(valor)).toBe(0);
    }
    // Near-miss: one centavo is a positive amount and counts.
    const umCentavo = emTransito(STATUS_PAGAMENTO.pendente, { valor: 0.01 });
    expect(calcular([expirado], [umCentavo])).toEqual({ emTransito: 0.01, disponivel: 9_999 });
  });

  it('sums the payments in flight to the cent, without float drift', () => {
    const pagamentos = [
      emTransito(STATUS_PAGAMENTO.pendente, { valor: 0.1 }),
      { ...emTransito(STATUS_PAGAMENTO.em_revisao, { valor: 0.2 }), id: 'p2' },
    ];
    expect(calcular([expirado], pagamentos).emTransito).toBe(0.3); // 0.1 + 0.2 !== 0.3 in floats
  });

  it('is restante − open links − money in flight, in centavos', () => {
    const links = [expirado, linkBruto('b', { valorCobrado: 33.33 })];
    const pagamentos = [emTransito(STATUS_PAGAMENTO.pendente)];
    // 100,00 − 33,33 (open) − 40,00 (in flight) = 26,67.
    expect(calcular(links, pagamentos).disponivel).toBe(2_667);
  });

  it('clamps at 0 when the stored links already cover more than restante', () => {
    const links = [expirado, linkBruto('b')];
    const pagamentos = [emTransito(STATUS_PAGAMENTO.pendente)];
    // Open 40 + in flight 40 = 80: never a negative figure, and exact at the edge.
    expect(calcular(links, pagamentos, 50).disponivel).toBe(0);
    expect(calcular(links, pagamentos, 80).disponivel).toBe(0);
    expect(calcular(links, pagamentos, 80.01).disponivel).toBe(1);
  });

  it('reads a missing or non-finite restante as nothing available (fail closed)', () => {
    for (const restante of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(calcular([], [], restante).disponivel, String(restante)).toBe(0);
    }
    expect(
      disponivelParaNovosLinksCentavos({ restante: undefined, resumos: [], pagamentos: [] }),
    ).toBe(0);
    // Near-miss: a real restante with nothing stored is all available.
    expect(calcular([], [], 100).disponivel).toBe(10_000);
  });
});

/* -------------------------------------------------------------------------- */
/*                            mensagemLinksPagamento                           */
/* -------------------------------------------------------------------------- */

describe('mensagemLinksPagamento', () => {
  // 2026-09-30 23:59:59 in São Paulo (-03:00) is 2026-10-01T02:59:59Z: the UTC
  // date is a day later than the date the payer sees.
  const FIM_30_09 = Date.UTC(2026, 9, 1, 2, 59, 59);
  const FIM_05_10 = Date.UTC(2026, 9, 6, 2, 59, 59);

  const individual = resumo({
    linkId: 'L1',
    nomePagador: 'Maria',
    valor: 33.34,
    dataExpiracaoMs: FIM_30_09,
    link: 'https://mp.example/a',
  });
  const compartilhado = resumo({
    linkId: 'L2',
    modo: MODO_LINK_PAGAMENTO.compartilhado,
    nomePagador: null,
    valor: 50,
    quantidadeMaxima: 3,
    pagos: 1,
    restantes: 2,
    situacao: SITUACAO_LINK_PAGAMENTO.parcial,
    dataExpiracaoMs: FIM_05_10,
    link: 'https://mp.example/b',
  });
  const semNome = resumo({
    linkId: 'L3',
    nomePagador: null,
    valor: 10,
    dataExpiracaoMs: null,
    link: 'https://mp.example/c',
  });

  it('writes one block per open link, blank-line separated, with a per-link deadline', () => {
    const mensagem = mensagemLinksPagamento({
      numeroPedido: '1234',
      resumos: [individual, compartilhado, semNome],
      fuso: FUSO,
    });
    expect(mensagem).toBe(
      [
        'Pedido 1234 — links de pagamento:',
        '',
        `Maria: ${formatReais(33.34)} (até 30/09)`,
        'https://mp.example/a',
        '',
        `Link compartilhado — 2 × ${formatReais(50)} (até 05/10)`,
        'https://mp.example/b',
        '',
        `Link 3: ${formatReais(10)}`,
        'https://mp.example/c',
      ].join('\n'),
    );
  });

  it('shows the deadline as the civil day in the given zone, not the UTC day', () => {
    const resumos = [individual];
    const emSaoPaulo = mensagemLinksPagamento({ numeroPedido: null, resumos, fuso: FUSO });
    expect(emSaoPaulo).toContain('(até 30/09)');
    expect(emSaoPaulo).not.toContain('01/10');
    const emUtc = mensagemLinksPagamento({ numeroPedido: null, resumos, fuso: 'UTC' });
    expect(emUtc).toContain('(até 01/10)');
  });

  it('uses the pedido-less header when there is no number', () => {
    for (const numeroPedido of [null, '']) {
      const mensagem = mensagemLinksPagamento({ numeroPedido, resumos: [individual], fuso: FUSO });
      expect(mensagem?.startsWith('Links de pagamento:\n\n')).toBe(true);
      expect(mensagem).not.toContain('Pedido');
    }
  });

  it('lists only links that can still be paid and have a URL', () => {
    const excluidos = [
      resumo({
        linkId: 'X1',
        situacao: SITUACAO_LINK_PAGAMENTO.pago,
        link: 'https://mp.example/x1',
      }),
      resumo({
        linkId: 'X2',
        situacao: SITUACAO_LINK_PAGAMENTO.expirado,
        link: 'https://mp.example/x2',
      }),
      resumo({
        linkId: 'X3',
        situacao: SITUACAO_LINK_PAGAMENTO.cancelado,
        link: 'https://mp.example/x3',
      }),
      resumo({
        linkId: 'X4',
        modo: null,
        rastreavel: false,
        situacao: SITUACAO_LINK_PAGAMENTO.legado,
        link: 'https://mp.example/x4',
      }),
      resumo({ linkId: 'X5', link: null }),
    ];
    const mensagem = mensagemLinksPagamento({
      numeroPedido: '1',
      resumos: [...excluidos, semNome],
      fuso: FUSO,
    });
    expect(mensagem).toContain('https://mp.example/c');
    for (const x of ['x1', 'x2', 'x3', 'x4', 'x5']) expect(mensagem).not.toContain(`/${x}`);
    // The unnamed link is "Link 1": numbered among the ones LISTED, not among all.
    expect(mensagem).toContain(`Link 1: ${formatReais(10)}`);
  });

  it('is null when nothing is payable', () => {
    expect(mensagemLinksPagamento({ numeroPedido: '1', resumos: [], fuso: FUSO })).toBeNull();
    expect(
      mensagemLinksPagamento({
        numeroPedido: '1',
        resumos: [resumo({ situacao: SITUACAO_LINK_PAGAMENTO.pago })],
        fuso: FUSO,
      }),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                             mensagemQuemJaPagou                             */
/* -------------------------------------------------------------------------- */

describe('mensagemQuemJaPagou', () => {
  const pago = (linkId: string, nome: string | null, dataAprovacao: number | null) =>
    resumo({
      linkId,
      nomePagador: nome,
      valor: 123.45,
      link: 'https://mp.example/segredo',
      pagos: 1,
      restantes: 0,
      valorRecebido: 123.45,
      pagantes: [{ nome, dataAprovacao }],
      situacao: SITUACAO_LINK_PAGAMENTO.pago,
    });

  it('lists who paid, oldest first, then who is still awaited', () => {
    const compartilhado = resumo({
      linkId: 'S1',
      modo: MODO_LINK_PAGAMENTO.compartilhado,
      nomePagador: 'Grupo',
      quantidadeMaxima: 4,
      pagos: 3,
      restantes: 1,
      pagantes: [
        { nome: 'Zeca', dataAprovacao: 1_000 },
        { nome: null, dataAprovacao: 2_000 },
        { nome: null, dataAprovacao: null },
      ],
      situacao: SITUACAO_LINK_PAGAMENTO.parcial,
    });
    const mensagem = mensagemQuemJaPagou({
      numeroPedido: '9',
      resumos: [
        pago('A', 'Maria', 3_000),
        compartilhado,
        resumo({ linkId: 'W1', nomePagador: 'Ana' }), // individual, open, named → awaited
        resumo({ linkId: 'W2', nomePagador: null }), // open but unnamed → nobody to name
        resumo({ linkId: 'W3', nomePagador: 'Bia', situacao: SITUACAO_LINK_PAGAMENTO.cancelado }),
        resumo({ linkId: 'W4', nomePagador: 'Cadu', situacao: SITUACAO_LINK_PAGAMENTO.expirado }),
        resumo({
          linkId: 'W5',
          modo: MODO_LINK_PAGAMENTO.compartilhado,
          nomePagador: 'Grupo2',
          quantidadeMaxima: 3,
          restantes: 3,
        }), // a shared link has no one to wait for by name
      ],
    });
    expect(mensagem).toBe(
      [
        'Pedido 9 — quem já pagou:',
        '✅ Zeca',
        '✅ Maria',
        '✅ 2 pagamento(s) sem nome',
        '',
        'Aguardando:',
        '⏳ Ana',
      ].join('\n'),
    );
  });

  it('has no Aguardando block when every named link paid', () => {
    const mensagem = mensagemQuemJaPagou({ numeroPedido: null, resumos: [pago('A', 'Maria', 1)] });
    expect(mensagem).toBe('Quem já pagou:\n✅ Maria');
  });

  it('is null when nobody has paid (open links alone do not make a message)', () => {
    expect(mensagemQuemJaPagou({ numeroPedido: '1', resumos: [] })).toBeNull();
    expect(
      mensagemQuemJaPagou({ numeroPedido: '1', resumos: [resumo({ nomePagador: 'Ana' })] }),
    ).toBeNull();
  });

  it('ignores legacy links entirely', () => {
    const legado = resumo({
      modo: null,
      rastreavel: false,
      pagantes: [{ nome: 'Fantasma', dataAprovacao: 1 }],
      situacao: SITUACAO_LINK_PAGAMENTO.legado,
    });
    expect(mensagemQuemJaPagou({ numeroPedido: '1', resumos: [legado] })).toBeNull();
  });

  it('carries first names ONLY: no amounts, no URLs, no other data', () => {
    const mensagem = mensagemQuemJaPagou({
      numeroPedido: null,
      resumos: [pago('A', 'Maria', 1), pago('B', 'João', 2), resumo({ nomePagador: 'Ana' })],
    });
    expect(mensagem).not.toBeNull();
    expect(mensagem).not.toContain('http');
    expect(mensagem).not.toContain('R$');
    expect(mensagem).not.toContain('123');
    expect(mensagem).not.toContain('mp.example');
    // With every payer named and no pedido number, not a single digit is left.
    expect(mensagem).not.toMatch(/\d/);
  });
});

/* -------------------------------------------------------------------------- */
/*                      resumo → mensagens (end to end)                        */
/* -------------------------------------------------------------------------- */

describe('from raw documents to the copy text', () => {
  it('a vaquinha where two of three paid', () => {
    const ids = ['AAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCCCCCC'];
    const nomes = ['Maria', 'João', 'Ana'];
    const links = ids.map((id, ordem) => ({
      id,
      data: {
        contaMercadoPagoOuterRef: 'documents/metodo_pgto/c',
        valorCobrado: ordem === 0 ? 33.34 : 33.33,
        link: `https://mp.example/${id}`,
        id: `pref-${ordem}`,
        dataCriacao: 1_000,
        dataExpiracao: Date.UTC(2026, 9, 1, 2, 59, 59),
        modo: MODO_LINK_PAGAMENTO.individual,
        nomePagador: nomes[ordem],
        quantidadeMaxima: 1,
        ordem,
        status: STATUS_LINK_PAGAMENTO.aberto,
      },
    }));
    const pagamentos = [
      {
        id: 'p1',
        data: {
          valor: 33.33,
          status_pagamento: STATUS_PAGAMENTO.aprovado,
          linkPagamentoId: ids[1],
          dataAprovacao: 1_727_000_002_000_000,
        },
      },
      {
        id: 'p2',
        data: {
          valor: 33.34,
          status_pagamento: STATUS_PAGAMENTO.aprovado,
          linkPagamentoId: ids[0],
          dataAprovacao: 1_727_000_001_000_000,
        },
      },
      // Ana's checkout was opened but the payment is still pending.
      {
        id: 'p3',
        data: {
          valor: 33.33,
          status_pagamento: STATUS_PAGAMENTO.pendente,
          linkPagamentoId: ids[2],
          dataAprovacao: null,
        },
      },
    ];
    const resumos = resumirLinksPagamento({ links, pagamentos, agoraMs: 1_727_000_010_000 });

    expect(resumos.map((r) => r.situacao)).toEqual([
      SITUACAO_LINK_PAGAMENTO.pago,
      SITUACAO_LINK_PAGAMENTO.pago,
      SITUACAO_LINK_PAGAMENTO.aberto,
    ]);
    expect(valorEmAbertoEmLinks(resumos)).toBe(33.33);
    expect(mensagemQuemJaPagou({ numeroPedido: null, resumos })).toBe(
      'Quem já pagou:\n✅ Maria\n✅ João\n\nAguardando:\n⏳ Ana',
    );
    const links30 = mensagemLinksPagamento({ numeroPedido: null, resumos, fuso: FUSO });
    expect(links30).toBe(
      [
        'Links de pagamento:',
        '',
        `Ana: ${formatReais(33.33)} (até 30/09)`,
        `https://mp.example/${ids[2]}`,
      ].join('\n'),
    );
  });
});
