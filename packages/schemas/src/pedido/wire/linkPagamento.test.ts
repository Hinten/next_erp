import { describe, expect, it } from 'vitest';
import {
  MODO_LINK_PAGAMENTO,
  STATUS_LINK_PAGAMENTO,
  TIPO_PAGAMENTO_MP,
  linkPagamentoIdSchema,
  linkPgtoMercadoPagoMeta,
  linkPgtoMercadoPagoSchema,
} from '../collection/linkPgtoMercadoPago';
import { ESTADO_PEDIDO } from '../collection/pedido';
import { LIMITES_LINK_PAGAMENTO, MOTIVO_RECUSA_LINK } from '../pureLogic/linkPagamento';
import {
  CODIGO_ERRO_LINK,
  PERM_LINK_PAGAMENTO,
  ROTA_LINK_PAGAMENTO,
  cancelarLinkPagamentoBodySchema,
  cancelarLinkPagamentoRespostaSchema,
  criarLinksPagamentoBodySchema,
  criarLinksPagamentoRespostaSchema,
  erroLinkPagamentoSchema,
  linkCriadoSchema,
  nomePagadorSchema,
  pedidoIdLinkSchema,
  sincronizarLinksPagamentoBodySchema,
  sincronizarLinksPagamentoRespostaSchema,
  valorLinkPagamentoSchema,
} from './linkPagamento';
import type { CriarLinksPagamentoBody } from './linkPagamento';

const LINK_A = 'AAAAAAAAAAAAAAAAAAAA';
const LINK_B = 'BBBBBBBBBBBBBBBBBBBB';

/** A valid two-person vaquinha, typed as the client builds it (defaults omitted). */
function corpoIndividual(sobre: Partial<CriarLinksPagamentoBody> = {}): CriarLinksPagamentoBody {
  return {
    pedidoId: 'pedido_123',
    metodoId: 'conta1',
    modo: MODO_LINK_PAGAMENTO.individual,
    valorCobradoEsperado: 100,
    expiraEm: '2026-09-30',
    links: [
      { linkId: LINK_A, nomePagador: 'Maria', valor: 50 },
      { linkId: LINK_B, nomePagador: 'João', valor: 50 },
    ],
    ...sobre,
  };
}

/** A valid shared link paid three times. */
function corpoCompartilhado(sobre: Partial<CriarLinksPagamentoBody> = {}): CriarLinksPagamentoBody {
  return corpoIndividual({
    modo: MODO_LINK_PAGAMENTO.compartilhado,
    quantidadeMaxima: 3,
    links: [{ linkId: LINK_A, nomePagador: null, valor: 33.33 }],
    ...sobre,
  });
}

/** The `{ path, message }` of every issue a body raises. */
function problemas(corpo: unknown): Array<{ path: PropertyKey[]; message: string }> {
  const r = criarLinksPagamentoBodySchema.safeParse(corpo);
  return r.success ? [] : r.error.issues.map((i) => ({ path: i.path, message: i.message }));
}

describe('constants', () => {
  it('the routes share one prefix and end in the three verbs', () => {
    expect(ROTA_LINK_PAGAMENTO).toEqual({
      criar: '/api/payments/mercado-pago/links/criar',
      cancelar: '/api/payments/mercado-pago/links/cancelar',
      sincronizar: '/api/payments/mercado-pago/links/sincronizar',
    });
  });

  it('the permission masks are the documented bits (hasPerm needs ALL of them)', () => {
    expect(PERM_LINK_PAGAMENTO.ler).toBe(1n << 24n); // pagamento.read
    expect(PERM_LINK_PAGAMENTO.listarContas).toBe(1n << 27n); // metodoPagamento.read
    // pedido.write | pagamento.write — TWO bits, not one.
    expect(PERM_LINK_PAGAMENTO.gerenciar).toBe((1n << 17n) | (1n << 25n));
    expect(PERM_LINK_PAGAMENTO.gerenciar & (1n << 17n)).not.toBe(0n);
    expect(PERM_LINK_PAGAMENTO.gerenciar & (1n << 25n)).not.toBe(0n);
    // `ler` is not implied by `gerenciar`.
    expect(PERM_LINK_PAGAMENTO.gerenciar & PERM_LINK_PAGAMENTO.ler).toBe(0n);
  });

  it('the limits agree with each other and with the link collection', () => {
    expect(LIMITES_LINK_PAGAMENTO.linksPorLoteMax).toBeLessThanOrEqual(
      LIMITES_LINK_PAGAMENTO.linksPorPedidoMax,
    );
    expect(LIMITES_LINK_PAGAMENTO.expiracaoDiasPadrao).toBeLessThanOrEqual(
      LIMITES_LINK_PAGAMENTO.expiracaoDiasMax,
    );
    // The tab builds its summaries from ONE page of the collection: a pedido can
    // never hold more links than that page shows.
    expect(LIMITES_LINK_PAGAMENTO.linksPorPedidoMax).toBeLessThanOrEqual(
      linkPgtoMercadoPagoMeta.defaultQuery?.limit ?? 0,
    );
    // Whatever the wire accepts, the stored document accepts.
    const { nomePagador, quantidadeMaxima, parcelasMaximas, valorCobrado } =
      linkPgtoMercadoPagoSchema.shape;
    expect(nomePagador.safeParse('a'.repeat(LIMITES_LINK_PAGAMENTO.nomePagadorMax)).success).toBe(
      true,
    );
    expect(
      nomePagador.safeParse('a'.repeat(LIMITES_LINK_PAGAMENTO.nomePagadorMax + 1)).success,
    ).toBe(false);
    expect(quantidadeMaxima.safeParse(LIMITES_LINK_PAGAMENTO.quantidadeMaximaMax).success).toBe(
      true,
    );
    expect(parcelasMaximas.safeParse(LIMITES_LINK_PAGAMENTO.parcelasMax).success).toBe(true);
    expect(valorCobrado.safeParse(LIMITES_LINK_PAGAMENTO.valorMinimo).success).toBe(true);
  });

  it('the error codes are distinct strings', () => {
    const codigos = Object.values(CODIGO_ERRO_LINK);
    expect(new Set(codigos).size).toBe(codigos.length);
    expect(CODIGO_ERRO_LINK.contaNaoConfigurada).toBe('MP_CONTA_NAO_CONFIGURADA');
  });
});

describe('field schemas', () => {
  it('nomePagador: a first-name label of letters, marks, space, dot, apostrophe, hyphen', () => {
    for (const ok of ['Maria', 'Maria S.', "D'Ávila", 'Ana-Clara', 'José', '山田', '  Bia  ']) {
      expect(nomePagadorSchema.safeParse(ok).success, ok).toBe(true);
    }
    // Trimmed before it is measured and stored.
    expect(nomePagadorSchema.parse('  Bia  ')).toBe('Bia');
  });

  it('nomePagador rejects digits, symbols, blanks and anything past 20 characters', () => {
    for (const ruim of ['Maria 1', 'a@b', 'Maria_S', '', '   ', 'a'.repeat(21), 'Ma\nria']) {
      expect(nomePagadorSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(false);
    }
    expect(nomePagadorSchema.safeParse('a'.repeat(20)).success).toBe(true); // the boundary
  });

  it('valor: at least R$ 1,00 and at most two decimals — rejected, never rounded', () => {
    for (const ok of [1, 33.34, 33.33, 100, 1234.5]) {
      expect(valorLinkPagamentoSchema.safeParse(ok).success, String(ok)).toBe(true);
    }
    for (const ruim of [0.999, 1.005, 33.335, 0, -5, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(valorLinkPagamentoSchema.safeParse(ruim).success, String(ruim)).toBe(false);
    }
    // A numeric string is not a number.
    expect(valorLinkPagamentoSchema.safeParse('33.34').success).toBe(false);
  });

  it('pedidoId: 1..64 of letters, digits, hyphen and underscore (external_reference)', () => {
    for (const ok of ['a', 'AbC123', 'pedido_1-2', 'x'.repeat(64), 'AAAAAAAAAAAAAAAAAAAA']) {
      expect(pedidoIdLinkSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const ruim of ['', 'x'.repeat(65), 'a/b', 'a b', 'ç', 'a.b']) {
      expect(pedidoIdLinkSchema.safeParse(ruim).success, ruim).toBe(false);
    }
  });
});

describe('criarLinksPagamentoBodySchema', () => {
  it('accepts a valid individual body and applies the defaults', () => {
    const r = criarLinksPagamentoBodySchema.safeParse(corpoIndividual());
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.tiposExcluidos).toEqual([]);
    expect(r.data.parcelasMaximas).toBeNull();
    expect(r.data.quantidadeMaxima).toBeNull();
    expect(r.data.preencherPagador).toBe(false);
    expect(r.data.links).toHaveLength(2);
  });

  it('accepts a valid shared body', () => {
    expect(criarLinksPagamentoBodySchema.safeParse(corpoCompartilhado()).success).toBe(true);
  });

  it('accepts one individual link, with or without a payer name', () => {
    const um = corpoIndividual({ links: [{ linkId: LINK_A, nomePagador: null, valor: 100 }] });
    expect(criarLinksPagamentoBodySchema.safeParse(um).success).toBe(true);
  });

  it('rejects an unknown key, at the top level and inside a link (strict)', () => {
    expect(
      criarLinksPagamentoBodySchema.safeParse({ ...corpoIndividual(), requestId: 'x' }).success,
    ).toBe(false);
    expect(
      criarLinksPagamentoBodySchema.safeParse(
        corpoIndividual({
          links: [{ linkId: LINK_A, nomePagador: 'Maria', valor: 50, paraCliente: true } as never],
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects the old field names the two slices used to disagree on', () => {
    const legado = {
      ...corpoIndividual(),
      modo: 'porPessoa',
      dataExpiracao: '2026-09-30',
    };
    expect(criarLinksPagamentoBodySchema.safeParse(legado).success).toBe(false);
  });

  it('every link needs the nomePagador key (null is fine, absent is not)', () => {
    const semChave = corpoIndividual({ links: [{ linkId: LINK_A, valor: 100 } as never] });
    expect(criarLinksPagamentoBodySchema.safeParse(semChave).success).toBe(false);
  });

  it('link ids are the 20-character client-minted shape', () => {
    for (const linkId of ['short', 'A'.repeat(21), `${'A'.repeat(19)}/`, `${'A'.repeat(19)}-`]) {
      const corpo = corpoIndividual({ links: [{ linkId, nomePagador: 'Maria', valor: 100 }] });
      expect(criarLinksPagamentoBodySchema.safeParse(corpo).success, linkId).toBe(false);
    }
    expect(linkPagamentoIdSchema.safeParse(LINK_A).success).toBe(true);
  });

  it('the batch holds 1..20 links', () => {
    const idsDistintos = Array.from(
      { length: LIMITES_LINK_PAGAMENTO.linksPorLoteMax + 1 },
      (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(18)}`,
    );
    const links = (n: number) =>
      idsDistintos.slice(0, n).map((linkId) => ({ linkId, nomePagador: null, valor: 10 }));
    expect(
      criarLinksPagamentoBodySchema.safeParse(corpoIndividual({ links: links(20) })).success,
    ).toBe(true);
    expect(
      criarLinksPagamentoBodySchema.safeParse(corpoIndividual({ links: links(21) })).success,
    ).toBe(false);
    expect(criarLinksPagamentoBodySchema.safeParse(corpoIndividual({ links: [] })).success).toBe(
      false,
    );
  });

  it('expiraEm must be a REAL civil date', () => {
    for (const ok of ['2026-09-30', '2028-02-29', '2026-12-31']) {
      expect(problemas(corpoIndividual({ expiraEm: ok })), ok).toEqual([]);
    }
    // '2026-02-30' has the right shape but is not a day; the others are not the shape.
    const invalidas = ['2026-02-30', '2027-02-29', '2026-9-30', '30/09/2026', '', '2026-09-30T00'];
    for (const ruim of invalidas) {
      expect(problemas(corpoIndividual({ expiraEm: ruim })).length, ruim).toBeGreaterThan(0);
    }
  });

  it('parcelasMaximas is null or 1..12; quantidadeMaxima is null or 2..50', () => {
    for (const parcelas of [null, 1, 12]) {
      expect(problemas(corpoIndividual({ parcelasMaximas: parcelas })), String(parcelas)).toEqual(
        [],
      );
    }
    for (const parcelas of [0, 13, 1.5, -1]) {
      expect(
        problemas(corpoIndividual({ parcelasMaximas: parcelas })).length,
        String(parcelas),
      ).toBeGreaterThan(0);
    }
    for (const qtd of [2, 3, 50]) {
      expect(problemas(corpoCompartilhado({ quantidadeMaxima: qtd })), String(qtd)).toEqual([]);
    }
    for (const qtd of [1, 0, 51, 2.5]) {
      expect(
        problemas(corpoCompartilhado({ quantidadeMaxima: qtd })).length,
        String(qtd),
      ).toBeGreaterThan(0);
    }
  });

  describe('tiposExcluidos', () => {
    it('accepts none up to three of the four types', () => {
      const { cartaoCredito, cartaoDebito, boleto } = TIPO_PAGAMENTO_MP;
      expect(problemas(corpoIndividual({ tiposExcluidos: [] }))).toEqual([]);
      expect(problemas(corpoIndividual({ tiposExcluidos: [boleto] }))).toEqual([]);
      expect(
        problemas(corpoIndividual({ tiposExcluidos: [cartaoCredito, cartaoDebito, boleto] })),
      ).toEqual([]);
    });

    it('rejects excluding all four (one payment method must stay on)', () => {
      const todos = Object.values(TIPO_PAGAMENTO_MP);
      expect(todos).toHaveLength(4);
      expect(problemas(corpoIndividual({ tiposExcluidos: todos })).length).toBeGreaterThan(0);
    });

    it('rejects a repeated type, at the second occurrence', () => {
      const { boleto } = TIPO_PAGAMENTO_MP;
      expect(problemas(corpoIndividual({ tiposExcluidos: [boleto, boleto] }))).toEqual([
        { path: ['tiposExcluidos', 1], message: 'Tipo de pagamento repetido.' },
      ]);
    });

    it('rejects a type Mercado Pago would not accept (account_money can never be excluded)', () => {
      const corpo = { ...corpoIndividual(), tiposExcluidos: ['account_money'] };
      expect(problemas(corpo).length).toBeGreaterThan(0);
    });
  });

  describe('cross-field rules (each arm rejects, and its valid twin passes)', () => {
    it('duplicate link ids', () => {
      const repetido = corpoIndividual({
        links: [
          { linkId: LINK_A, nomePagador: 'Maria', valor: 50 },
          { linkId: LINK_A, nomePagador: 'João', valor: 50 },
        ],
      });
      expect(problemas(repetido)).toEqual([
        { path: ['links', 1, 'linkId'], message: 'Identificador de link repetido.' },
      ]);
      expect(problemas(corpoIndividual())).toEqual([]); // twin: distinct ids
    });

    it('a shared link has exactly one link', () => {
      const dois = corpoCompartilhado({
        links: [
          { linkId: LINK_A, nomePagador: null, valor: 25 },
          { linkId: LINK_B, nomePagador: null, valor: 25 },
        ],
      });
      expect(problemas(dois)).toEqual([
        { path: ['links'], message: 'O link compartilhado tem exatamente um link.' },
      ]);
      expect(problemas(corpoCompartilhado())).toEqual([]); // twin: one link
    });

    it('a shared link needs a quantidadeMaxima', () => {
      expect(problemas(corpoCompartilhado({ quantidadeMaxima: null }))).toEqual([
        {
          path: ['quantidadeMaxima'],
          message: 'Informe quantas pessoas vão pagar o link compartilhado.',
        },
      ]);
      const semChave = { ...corpoCompartilhado() } as Record<string, unknown>;
      delete semChave.quantidadeMaxima; // absent defaults to null
      expect(problemas(semChave).map((p) => p.path)).toEqual([['quantidadeMaxima']]);
      expect(problemas(corpoCompartilhado({ quantidadeMaxima: 2 }))).toEqual([]); // twin
    });

    it('an individual body must not carry a quantidadeMaxima', () => {
      expect(problemas(corpoIndividual({ quantidadeMaxima: 2 }))).toEqual([
        {
          path: ['quantidadeMaxima'],
          message: 'A quantidade máxima só vale para o link compartilhado.',
        },
      ]);
      expect(problemas(corpoIndividual({ quantidadeMaxima: null }))).toEqual([]); // twin
    });

    it('preencherPagador only for a SINGLE INDIVIDUAL link', () => {
      const unico = { linkId: LINK_A, nomePagador: 'Maria', valor: 100 };
      // Twin: one individual link.
      expect(problemas(corpoIndividual({ preencherPagador: true, links: [unico] }))).toEqual([]);
      // Arm 1: an individual body with two links.
      expect(problemas(corpoIndividual({ preencherPagador: true }))).toEqual([
        {
          path: ['preencherPagador'],
          message: 'Só é possível preencher o pagador em um único link individual.',
        },
      ]);
      // Arm 2: a shared body, even with one link.
      expect(problemas(corpoCompartilhado({ preencherPagador: true })).map((p) => p.path)).toEqual([
        ['preencherPagador'],
      ]);
      // And false is always fine.
      expect(problemas(corpoIndividual({ preencherPagador: false }))).toEqual([]);
    });

    it('reports several independent problems at once', () => {
      const varios = corpoIndividual({
        quantidadeMaxima: 2,
        preencherPagador: true,
        links: [
          { linkId: LINK_A, nomePagador: 'Maria', valor: 50 },
          { linkId: LINK_A, nomePagador: 'João', valor: 50 },
        ],
      });
      expect(problemas(varios).map((p) => p.path)).toEqual([
        ['links', 1, 'linkId'],
        ['quantidadeMaxima'],
        ['preencherPagador'],
      ]);
    });
  });

  it('a per-link value below the minimum or with three decimals rejects the whole body', () => {
    for (const valor of [0.999, 1.005]) {
      const corpo = corpoIndividual({ links: [{ linkId: LINK_A, nomePagador: null, valor }] });
      expect(criarLinksPagamentoBodySchema.safeParse(corpo).success, String(valor)).toBe(false);
    }
    const ok = corpoIndividual({ links: [{ linkId: LINK_A, nomePagador: null, valor: 33.34 }] });
    expect(criarLinksPagamentoBodySchema.safeParse(ok).success).toBe(true);
  });
});

describe('cancelar / sincronizar bodies', () => {
  it('cancelar takes a pedido id and a link id, strictly', () => {
    expect(
      cancelarLinkPagamentoBodySchema.safeParse({ pedidoId: 'p1', linkId: LINK_A }).success,
    ).toBe(true);
    expect(cancelarLinkPagamentoBodySchema.safeParse({ pedidoId: 'p1' }).success).toBe(false);
    expect(
      cancelarLinkPagamentoBodySchema.safeParse({ pedidoId: 'p1', linkId: 'curto' }).success,
    ).toBe(false);
    expect(
      cancelarLinkPagamentoBodySchema.safeParse({ pedidoId: 'p1', linkId: LINK_A, extra: 1 })
        .success,
    ).toBe(false);
  });

  it('sincronizar takes a pedido id, strictly', () => {
    expect(sincronizarLinksPagamentoBodySchema.safeParse({ pedidoId: 'p1' }).success).toBe(true);
    expect(sincronizarLinksPagamentoBodySchema.safeParse({}).success).toBe(false);
    expect(sincronizarLinksPagamentoBodySchema.safeParse({ pedidoId: 'p/1' }).success).toBe(false);
    expect(
      sincronizarLinksPagamentoBodySchema.safeParse({ pedidoId: 'p1', metodoId: 'x' }).success,
    ).toBe(false);
  });
});

describe('response schemas (tolerant of extra keys, strict about the fields they name)', () => {
  const linkCriado = {
    linkId: LINK_A,
    preferenceId: '123-abc',
    link: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=123-abc',
    valorCobrado: 33.34,
    nomePagador: 'Maria',
    dataExpiracao: 1_727_000_000_000,
    modo: MODO_LINK_PAGAMENTO.individual,
    quantidadeMaxima: null,
  };

  it('criar: a link and the resulting estado', () => {
    const resposta = {
      links: [linkCriado],
      estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      reaproveitado: false,
    };
    expect(criarLinksPagamentoRespostaSchema.safeParse(resposta).success).toBe(true);
    expect(criarLinksPagamentoRespostaSchema.safeParse({ ...resposta, estado: null }).success).toBe(
      true,
    );
    // Near-misses: an estado that does not exist, a missing flag.
    expect(
      criarLinksPagamentoRespostaSchema.safeParse({ ...resposta, estado: 'aguardando' }).success,
    ).toBe(false);
    expect(
      criarLinksPagamentoRespostaSchema.safeParse({ links: [linkCriado], estado: null }).success,
    ).toBe(false);
  });

  it('criar: tolerates a field a newer backend adds, and drops it', () => {
    const r = criarLinksPagamentoRespostaSchema.safeParse({
      links: [{ ...linkCriado, novoCampo: 1 }],
      estado: null,
      reaproveitado: true,
      outroCampo: 'x',
    });
    expect(r.success).toBe(true);
    expect(linkCriadoSchema.safeParse({ ...linkCriado, novoCampo: 1 }).success).toBe(true);
  });

  it('criar: a link with the wrong shape is rejected', () => {
    for (const ruim of [
      { ...linkCriado, modo: 'porPessoa' },
      { ...linkCriado, dataExpiracao: '2026-09-30' },
      { ...linkCriado, quantidadeMaxima: 1.5 },
      { ...linkCriado, link: undefined },
    ]) {
      expect(linkCriadoSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(false);
    }
  });

  it('cancelar: the link id and its stored status', () => {
    expect(
      cancelarLinkPagamentoRespostaSchema.safeParse({
        linkId: LINK_A,
        status: STATUS_LINK_PAGAMENTO.cancelado,
        extra: true,
      }).success,
    ).toBe(true);
    expect(
      cancelarLinkPagamentoRespostaSchema.safeParse({ linkId: LINK_A, status: 'encerrado' })
        .success,
    ).toBe(false);
    expect(cancelarLinkPagamentoRespostaSchema.safeParse({ ok: true }).success).toBe(false);
  });

  it('sincronizar: the counters, the failures and the estados it moved through', () => {
    const resposta = {
      encontrados: 3,
      reconciliados: 2,
      ignorados: 1,
      falhas: [{ paymentId: '99', motivo: 'timeout' }],
      transicoes: [ESTADO_PEDIDO.pago],
      truncado: false,
    };
    expect(sincronizarLinksPagamentoRespostaSchema.safeParse(resposta).success).toBe(true);
    expect(
      sincronizarLinksPagamentoRespostaSchema.safeParse({ ...resposta, extra: 1 }).success,
    ).toBe(true);
    expect(
      sincronizarLinksPagamentoRespostaSchema.safeParse({ ...resposta, transicoes: ['quitado'] })
        .success,
    ).toBe(false);
    expect(
      sincronizarLinksPagamentoRespostaSchema.safeParse({ ...resposta, encontrados: 1.5 }).success,
    ).toBe(false);
    // The shape a slice once assumed — it is NOT this contract.
    expect(
      sincronizarLinksPagamentoRespostaSchema.safeParse({ encontrados: 3, atualizados: 2 }).success,
    ).toBe(false);
  });

  it('erro: a message, an optional code and an optional reason from the shared vocabulary', () => {
    expect(erroLinkPagamentoSchema.safeParse({ error: 'falhou' }).success).toBe(true);
    expect(
      erroLinkPagamentoSchema.safeParse({
        error: 'Não elegível',
        code: CODIGO_ERRO_LINK.naoElegivel,
        reason: MOTIVO_RECUSA_LINK.estado,
      }).success,
    ).toBe(true);
    expect(
      erroLinkPagamentoSchema.safeParse({ error: 'x', code: null, reason: null }).success,
    ).toBe(true);
    // A reason outside the vocabulary is a contract violation.
    const invalido = erroLinkPagamentoSchema.safeParse({ error: 'x', reason: 'estado-invalido' });
    expect(invalido.success).toBe(false);
    expect(erroLinkPagamentoSchema.safeParse({ code: 'X' }).success).toBe(false);
  });
});
