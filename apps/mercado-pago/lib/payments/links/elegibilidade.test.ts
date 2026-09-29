import { describe, expect, it } from 'vitest';
import {
  ESTADO_NFE,
  ESTADO_PEDIDO,
  FORMA_PAGAMENTO,
  LIMITES_LINK_PAGAMENTO,
  MODO_LINK_PAGAMENTO,
  MOTIVO_RECUSA_LINK,
  STATUS_LINK_PAGAMENTO,
  STATUS_PAGAMENTO,
  type EstadoNFe,
  type EstadoPedido,
} from '@delfrance/schemas';

import {
  avaliarElegibilidade,
  nfeMaisRecenteTravaPagamentos,
  type EntradaElegibilidade,
} from './elegibilidade';

const AGORA = Date.UTC(2026, 8, 29, 15, 0, 0);
const DIA = 86_400_000;

/** A saída pedido, `iniciado`, R$ 100,00, nothing paid, one link for the whole total. */
function entrada(sobra: Partial<EntradaElegibilidade> = {}): EntradaElegibilidade {
  return {
    pedido: {
      ehSaida: true,
      estado: ESTADO_PEDIDO.iniciado,
      valorCobrado: 100,
      itensDevolvidos: null,
    },
    pagamentos: [],
    links: [],
    canalMarketplace: false,
    pagamentosTravadosPorNFe: false,
    novos: [{ valor: 100, quantidade: 1 }],
    valorCobradoEsperado: 100,
    agoraMs: AGORA,
    ...sobra,
  };
}

/** A stored link, raw — an open individual link of R$ 40,00 unless overridden. */
function link(id: string, sobra: Record<string, unknown> = {}) {
  return {
    id,
    data: {
      modo: MODO_LINK_PAGAMENTO.individual,
      status: STATUS_LINK_PAGAMENTO.aberto,
      valorCobrado: 40,
      quantidadeMaxima: 1,
      dataExpiracao: AGORA + 3 * DIA,
      ...sobra,
    },
  };
}

/** A stored pagamento, raw — an approved pix unless overridden. */
function pagamento(id: string, valor: number, sobra: Record<string, unknown> = {}) {
  return {
    id,
    data: {
      valor,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      forma_de_pagamento: FORMA_PAGAMENTO.pix,
      ...sobra,
    },
  };
}

/** `n` cancelled links — stored, counted by the per-pedido cap, worth nothing in exposure. */
function linksCancelados(n: number) {
  return Array.from({ length: n }, (_, k) =>
    link(`cancelado${k}`, { status: STATUS_LINK_PAGAMENTO.cancelado }),
  );
}

describe('avaliarElegibilidade — the happy path', () => {
  it('accepts one link for the whole remaining total', () => {
    expect(avaliarElegibilidade(entrada())).toBeNull();
  });
});

describe('avaliarElegibilidade — 1. the total the operator saw', () => {
  it('refuses a split made on a total that is one centavo off', () => {
    expect(avaliarElegibilidade(entrada({ valorCobradoEsperado: 100.01 }))).toBe(
      MOTIVO_RECUSA_LINK.valorDesatualizado,
    );
    expect(avaliarElegibilidade(entrada({ valorCobradoEsperado: 99.99 }))).toBe(
      MOTIVO_RECUSA_LINK.valorDesatualizado,
    );
  });

  it('compares in centavos: the same total spelled with float noise is accepted', () => {
    expect(avaliarElegibilidade(entrada({ valorCobradoEsperado: 100.00000000001 }))).toBeNull();
  });

  it('refuses a non-finite expected total instead of comparing it', () => {
    expect(avaliarElegibilidade(entrada({ valorCobradoEsperado: Number.NaN }))).toBe(
      MOTIVO_RECUSA_LINK.valorDesatualizado,
    );
  });

  it('reads a pedido with no numeric total as R$ 0 — so a non-zero expectation is stale', () => {
    const semTotal = entrada({
      pedido: { ehSaida: true, estado: ESTADO_PEDIDO.iniciado, valorCobrado: null },
    });
    expect(avaliarElegibilidade(semTotal)).toBe(MOTIVO_RECUSA_LINK.valorDesatualizado);
    // ...and with the operator ALSO seeing R$ 0 the answer is "nothing to charge".
    expect(avaliarElegibilidade({ ...semTotal, valorCobradoEsperado: 0 })).toBe(
      MOTIVO_RECUSA_LINK.semValor,
    );
  });

  it('is decided BEFORE the pedido gates (a stale total on a paid pedido says stale)', () => {
    const pago = entrada({
      pedido: { ehSaida: true, estado: ESTADO_PEDIDO.pago, valorCobrado: 100 },
      valorCobradoEsperado: 90,
    });
    expect(avaliarElegibilidade(pago)).toBe(MOTIVO_RECUSA_LINK.valorDesatualizado);
    expect(avaliarElegibilidade({ ...pago, valorCobradoEsperado: 100 })).toBe(
      MOTIVO_RECUSA_LINK.estado,
    );
  });
});

describe('avaliarElegibilidade — 2. the pedido gates', () => {
  it('refuses an entrada, but not a pedido whose ehSaida is absent', () => {
    const base = entrada().pedido;
    expect(avaliarElegibilidade(entrada({ pedido: { ...base, ehSaida: false } }))).toBe(
      MOTIVO_RECUSA_LINK.entrada,
    );
    expect(avaliarElegibilidade(entrada({ pedido: { ...base, ehSaida: null } }))).toBeNull();
    expect(avaliarElegibilidade(entrada({ pedido: { ...base, ehSaida: undefined } }))).toBeNull();
  });

  it('refuses a marketplace channel', () => {
    expect(avaliarElegibilidade(entrada({ canalMarketplace: true }))).toBe(
      MOTIVO_RECUSA_LINK.canal,
    );
  });

  it('refuses an estado outside the allow-list, and allows every member of it', () => {
    const base = entrada().pedido;
    const permitidos: EstadoPedido[] = [
      ESTADO_PEDIDO.iniciado,
      ESTADO_PEDIDO.carrinho,
      ESTADO_PEDIDO.escolhendoFormaDePagamento,
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      ESTADO_PEDIDO.pagamentoNaoRealizado,
    ];
    for (const estado of permitidos) {
      expect(avaliarElegibilidade(entrada({ pedido: { ...base, estado } })), estado).toBeNull();
    }
    for (const estado of [
      ESTADO_PEDIDO.pago,
      ESTADO_PEDIDO.cancelado,
      ESTADO_PEDIDO.emProcessamento,
    ]) {
      expect(avaliarElegibilidade(entrada({ pedido: { ...base, estado } })), estado).toBe(
        MOTIVO_RECUSA_LINK.estado,
      );
    }
  });

  it('refuses when an NF-e locks the pagamentos', () => {
    expect(avaliarElegibilidade(entrada({ pagamentosTravadosPorNFe: true }))).toBe(
      MOTIVO_RECUSA_LINK.nfe,
    );
  });

  it('refuses a pedido that is already fully paid', () => {
    expect(avaliarElegibilidade(entrada({ pagamentos: [pagamento('p1', 100)] }))).toBe(
      MOTIVO_RECUSA_LINK.semValor,
    );
  });

  it('refuses a remainder below R$ 1,00 and accepts exactly R$ 1,00', () => {
    const umReal = entrada({
      pagamentos: [pagamento('p1', 99)],
      novos: [{ valor: 1, quantidade: 1 }],
    });
    expect(avaliarElegibilidade(umReal)).toBeNull();
    expect(avaliarElegibilidade({ ...umReal, pagamentos: [pagamento('p1', 99.01)] })).toBe(
      MOTIVO_RECUSA_LINK.semValor,
    );
  });
});

describe('avaliarElegibilidade — the restante is the ONE coverage rule', () => {
  it('counts the paying pagamentos only (pending, refused and corrupt rows pay nothing)', () => {
    const naoPagam = [
      pagamento('pendente', 60, { status_pagamento: STATUS_PAGAMENTO.pendente }),
      pagamento('recusado', 60, { status_pagamento: STATUS_PAGAMENTO.recusado }),
      pagamento('estornado', 60, { status_pagamento: STATUS_PAGAMENTO.estornado }),
      pagamento('corrompido', 60, { status_pagamento: 'aprovado' }),
    ];
    expect(avaliarElegibilidade(entrada({ pagamentos: naoPagam }))).toBeNull();

    // Near-miss: an approved row and one with NO status (the canonical "paying") do count.
    expect(avaliarElegibilidade(entrada({ pagamentos: [pagamento('p1', 60)] }))).toBe(
      MOTIVO_RECUSA_LINK.excedeRestante,
    );
    expect(
      avaliarElegibilidade(
        entrada({ pagamentos: [pagamento('p1', 60, { status_pagamento: null })] }),
      ),
    ).toBe(MOTIVO_RECUSA_LINK.excedeRestante);
  });

  it('sizes the links against what is LEFT after the paying pagamentos', () => {
    const base = entrada({ pagamentos: [pagamento('p1', 60)] });
    expect(avaliarElegibilidade({ ...base, novos: [{ valor: 40, quantidade: 1 }] })).toBeNull();
    expect(avaliarElegibilidade({ ...base, novos: [{ valor: 40.01, quantidade: 1 }] })).toBe(
      MOTIVO_RECUSA_LINK.excedeRestante,
    );
  });

  it('counts a troca’s returned items as paid', () => {
    const troca = entrada({
      pedido: {
        ehSaida: true,
        estado: ESTADO_PEDIDO.iniciado,
        valorCobrado: 100,
        itensDevolvidos: {
          origem1: { p1: [{ precoDeVenda: 30, descontoUnitario: 0, quantidade: 1 }] },
        },
      },
    });
    expect(avaliarElegibilidade({ ...troca, novos: [{ valor: 70, quantidade: 1 }] })).toBeNull();
    expect(avaliarElegibilidade({ ...troca, novos: [{ valor: 70.01, quantidade: 1 }] })).toBe(
      MOTIVO_RECUSA_LINK.excedeRestante,
    );
    // Near-miss: take the returned items away and the SAME R$ 70,01 fits — the
    // devolução credit is what made it refuse above.
    const semDevolucao = { ...troca.pedido, itensDevolvidos: null };
    expect(
      avaliarElegibilidade({
        ...troca,
        pedido: semDevolucao,
        novos: [{ valor: 70.01, quantidade: 1 }],
      }),
    ).toBeNull();
  });

  it('does not count a crédito-loja pagamento on top of the returned value', () => {
    // The operator registered the R$ 30,00 return as a crédito loja (for the NF-e):
    // the credit is the returned value MINUS it, so the 30 is counted once, not twice.
    const troca = entrada({
      pedido: {
        ehSaida: true,
        estado: ESTADO_PEDIDO.iniciado,
        valorCobrado: 100,
        itensDevolvidos: {
          origem1: { p1: [{ precoDeVenda: 30, descontoUnitario: 0, quantidade: 1 }] },
        },
      },
      pagamentos: [pagamento('cl', 30, { forma_de_pagamento: FORMA_PAGAMENTO.credito_loja })],
    });
    expect(avaliarElegibilidade({ ...troca, novos: [{ valor: 70, quantidade: 1 }] })).toBeNull();
    expect(avaliarElegibilidade({ ...troca, novos: [{ valor: 70.01, quantidade: 1 }] })).toBe(
      MOTIVO_RECUSA_LINK.excedeRestante,
    );
  });
});

describe('avaliarElegibilidade — 3. the per-pedido cap', () => {
  it('refuses the link that would be one past the cap, and accepts the one AT it', () => {
    const max = LIMITES_LINK_PAGAMENTO.linksPorPedidoMax;
    expect(avaliarElegibilidade(entrada({ links: linksCancelados(max - 1) }))).toBeNull();
    expect(avaliarElegibilidade(entrada({ links: linksCancelados(max) }))).toBe(
      MOTIVO_RECUSA_LINK.limiteLinks,
    );
  });

  it('counts the whole batch, not just one', () => {
    const max = LIMITES_LINK_PAGAMENTO.linksPorPedidoMax;
    const dois = {
      novos: [
        { valor: 50, quantidade: 1 },
        { valor: 50, quantidade: 1 },
      ],
    };
    expect(avaliarElegibilidade(entrada({ ...dois, links: linksCancelados(max - 2) }))).toBeNull();
    expect(avaliarElegibilidade(entrada({ ...dois, links: linksCancelados(max - 1) }))).toBe(
      MOTIVO_RECUSA_LINK.limiteLinks,
    );
  });

  it('counts legacy and unreadable rows too — the tab lists every stored link', () => {
    const max = LIMITES_LINK_PAGAMENTO.linksPorPedidoMax;
    const links = [
      ...linksCancelados(max - 3),
      { id: 'legado', data: { valorCobrado: 40, dataExpiracao: AGORA + DIA } },
      { id: 'nulo', data: null },
      { id: 'texto', data: 'lixo' },
    ];
    expect(avaliarElegibilidade(entrada({ links }))).toBe(MOTIVO_RECUSA_LINK.limiteLinks);
    expect(avaliarElegibilidade(entrada({ links: links.slice(0, -1) }))).toBeNull();
  });
});

describe('avaliarElegibilidade — 4. the exposure (no tolerance)', () => {
  it('accepts a batch that sums EXACTLY to the restante and refuses one centavo more', () => {
    const tres = [
      { valor: 33.34, quantidade: 1 },
      { valor: 33.33, quantidade: 1 },
      { valor: 33.33, quantidade: 1 },
    ];
    expect(avaliarElegibilidade(entrada({ novos: tres }))).toBeNull();
    expect(
      avaliarElegibilidade(
        entrada({
          novos: [
            { valor: 33.34, quantidade: 1 },
            { valor: 33.34, quantidade: 1 },
            { valor: 33.33, quantidade: 1 },
          ],
        }),
      ),
    ).toBe(MOTIVO_RECUSA_LINK.excedeRestante);
  });

  it('multiplies a shared link by the payments it accepts', () => {
    // 4 × 25,00 = 100,00 fits; 3 × 33,34 = 100,02 does not (no round-up allowance);
    // 3 × 33,33 = 99,99 fits.
    expect(avaliarElegibilidade(entrada({ novos: [{ valor: 25, quantidade: 4 }] }))).toBeNull();
    expect(avaliarElegibilidade(entrada({ novos: [{ valor: 33.33, quantidade: 3 }] }))).toBeNull();
    expect(avaliarElegibilidade(entrada({ novos: [{ valor: 33.34, quantidade: 3 }] }))).toBe(
      MOTIVO_RECUSA_LINK.excedeRestante,
    );
    // The quantity is what multiplies: the same R$ 25,00 five times is 125.
    expect(avaliarElegibilidade(entrada({ novos: [{ valor: 25, quantidade: 5 }] }))).toBe(
      MOTIVO_RECUSA_LINK.excedeRestante,
    );
  });

  it('adds the links still open to what the new batch could bring in', () => {
    const aberto = entrada({ links: [link('a', { valorCobrado: 40 })] });
    expect(avaliarElegibilidade({ ...aberto, novos: [{ valor: 60, quantidade: 1 }] })).toBeNull();
    expect(avaliarElegibilidade({ ...aberto, novos: [{ valor: 60.01, quantidade: 1 }] })).toBe(
      MOTIVO_RECUSA_LINK.excedeRestante,
    );
  });

  it('counts an open SHARED link once per payment it still accepts', () => {
    // 4 × 20,00, one already paid: that one is in `valorPago` (restante = 80) and the
    // 3 payments the link still accepts are the open exposure (3 × 20 = 60).
    const compartilhado = entrada({
      links: [
        link('c', {
          modo: MODO_LINK_PAGAMENTO.compartilhado,
          valorCobrado: 20,
          quantidadeMaxima: 4,
        }),
      ],
      pagamentos: [pagamento('p1', 20, { linkPagamentoId: 'c' })],
    });
    expect(
      avaliarElegibilidade({ ...compartilhado, novos: [{ valor: 20, quantidade: 1 }] }),
    ).toBeNull();
    expect(
      avaliarElegibilidade({ ...compartilhado, novos: [{ valor: 20.01, quantidade: 1 }] }),
    ).toBe(MOTIVO_RECUSA_LINK.excedeRestante);
    // Near-miss: the same payment NOT attributed to the link is a plain pagamento —
    // the link is then untouched (4 × 20 = 80 of exposure) against the same restante
    // of 80, and even R$ 20,00 more no longer fits.
    expect(
      avaliarElegibilidade({
        ...compartilhado,
        pagamentos: [pagamento('p1', 20)],
        novos: [{ valor: 20, quantidade: 1 }],
      }),
    ).toBe(MOTIVO_RECUSA_LINK.excedeRestante);
  });

  it('counts a link whose payment is still PENDING as fully open', () => {
    const pendente = entrada({
      links: [link('a', { valorCobrado: 40 })],
      pagamentos: [
        pagamento('p1', 40, {
          linkPagamentoId: 'a',
          status_pagamento: STATUS_PAGAMENTO.pendente,
        }),
      ],
    });
    // restante is still 100 (a pending payment pays nothing) and the link is still
    // worth 40 of exposure.
    expect(avaliarElegibilidade({ ...pendente, novos: [{ valor: 60, quantidade: 1 }] })).toBeNull();
    expect(avaliarElegibilidade({ ...pendente, novos: [{ valor: 60.01, quantidade: 1 }] })).toBe(
      MOTIVO_RECUSA_LINK.excedeRestante,
    );
  });

  it('counts a link at the exact instant of its expiry, and not one millisecond later', () => {
    const emExpiracao = (dataExpiracao: number) =>
      entrada({
        links: [link('a', { valorCobrado: 40, dataExpiracao })],
        novos: [{ valor: 100, quantidade: 1 }],
      });
    expect(avaliarElegibilidade(emExpiracao(AGORA))).toBe(MOTIVO_RECUSA_LINK.excedeRestante);
    expect(avaliarElegibilidade(emExpiracao(AGORA - 1))).toBeNull();
  });

  it('counts nothing for a paid, cancelled, concluded, expired or legacy link', () => {
    const cheio = { novos: [{ valor: 100, quantidade: 1 }] };
    // Near-miss first: the SAME link, open, blocks a full-total link.
    expect(avaliarElegibilidade(entrada({ ...cheio, links: [link('a')] }))).toBe(
      MOTIVO_RECUSA_LINK.excedeRestante,
    );

    const semExposicao = [
      link('cancelado', { status: STATUS_LINK_PAGAMENTO.cancelado }),
      link('concluido', { status: STATUS_LINK_PAGAMENTO.concluido }),
      link('expirado', { dataExpiracao: AGORA - DIA }),
      // A legacy link: no `modo` — payments cannot be attributed to it.
      { id: 'legado', data: { valorCobrado: 40, dataExpiracao: AGORA + DIA } },
    ];
    for (const stored of semExposicao) {
      expect(avaliarElegibilidade(entrada({ ...cheio, links: [stored] })), stored.id).toBeNull();
    }
  });

  it('counts nothing for a link that is already paid — its money is in valorPago instead', () => {
    const paga = entrada({
      links: [link('a', { valorCobrado: 40 })],
      pagamentos: [pagamento('p1', 40, { linkPagamentoId: 'a' })],
    });
    // restante 60, exposure 0: R$ 60,00 fits and R$ 60,01 does not.
    expect(avaliarElegibilidade({ ...paga, novos: [{ valor: 60, quantidade: 1 }] })).toBeNull();
    expect(avaliarElegibilidade({ ...paga, novos: [{ valor: 60.01, quantidade: 1 }] })).toBe(
      MOTIVO_RECUSA_LINK.excedeRestante,
    );
  });

  describe('the money in flight on links that are no longer open', () => {
    // A R$ 40,00 link that expired yesterday, with a Pix issued before it lapsed.
    const expirado = link('a', { valorCobrado: 40, dataExpiracao: AGORA - DIA });
    const emTransito = (status: unknown, sobra: Record<string, unknown> = {}) =>
      pagamento('p1', 40, { linkPagamentoId: 'a', status_pagamento: status, ...sobra });

    it('refuses a batch sized to the whole restante while a pending payment can still land', () => {
      // restante 100 (a pending payment pays nothing), open exposure 0 (expired),
      // in flight 40: R$ 100,00 more would overpay when the Pix is approved.
      const base = entrada({
        links: [expirado],
        pagamentos: [emTransito(STATUS_PAGAMENTO.pendente)],
      });
      expect(avaliarElegibilidade({ ...base, novos: [{ valor: 100, quantidade: 1 }] })).toBe(
        MOTIVO_RECUSA_LINK.excedeRestante,
      );
      // ...and the exact room left is restante − in flight, to the centavo.
      expect(avaliarElegibilidade({ ...base, novos: [{ valor: 60, quantidade: 1 }] })).toBeNull();
      expect(avaliarElegibilidade({ ...base, novos: [{ valor: 60.01, quantidade: 1 }] })).toBe(
        MOTIVO_RECUSA_LINK.excedeRestante,
      );
    });

    it('counts every non-final pending status: pendente, em revisão, em processo de aprovação', () => {
      for (const status of [
        STATUS_PAGAMENTO.pendente,
        STATUS_PAGAMENTO.em_revisao,
        STATUS_PAGAMENTO.em_processo_aprovacao,
      ]) {
        const e = entrada({ links: [expirado], pagamentos: [emTransito(status)] });
        expect(avaliarElegibilidade(e), String(status)).toBe(MOTIVO_RECUSA_LINK.excedeRestante);
      }
    });

    it('counts nothing for a payment that is final, already paying or unreadable (near-miss)', () => {
      for (const status of [
        STATUS_PAGAMENTO.recusado,
        STATUS_PAGAMENTO.cancelado,
        STATUS_PAGAMENTO.estornado,
        'pendente',
        null,
      ]) {
        // `null` is a PAYING row: it is in `valorPago` (restante 60), so 60 still fits.
        const e = entrada({
          links: [expirado],
          pagamentos: [emTransito(status)],
          novos: [{ valor: status === null ? 60 : 100, quantidade: 1 }],
        });
        expect(avaliarElegibilidade(e), String(status)).toBeNull();
      }
    });

    it('counts it on a cancelled, a concluded and a paid link as on an expired one', () => {
      const naoAbertos = [
        link('a', { valorCobrado: 40, status: STATUS_LINK_PAGAMENTO.cancelado }),
        link('a', { valorCobrado: 40, status: STATUS_LINK_PAGAMENTO.concluido }),
      ];
      for (const stored of naoAbertos) {
        const e = entrada({ links: [stored], pagamentos: [emTransito(STATUS_PAGAMENTO.pendente)] });
        expect(avaliarElegibilidade(e), String(stored.data.status)).toBe(
          MOTIVO_RECUSA_LINK.excedeRestante,
        );
      }
      // A paid individual link (one approved payment) with a SECOND payment pending
      // on it: restante 60, and the pending 40 may still land on top.
      const pago = entrada({
        links: [link('a', { valorCobrado: 40 })],
        pagamentos: [
          pagamento('p0', 40, { linkPagamentoId: 'a' }),
          emTransito(STATUS_PAGAMENTO.pendente),
        ],
      });
      expect(avaliarElegibilidade({ ...pago, novos: [{ valor: 20, quantidade: 1 }] })).toBeNull();
      expect(avaliarElegibilidade({ ...pago, novos: [{ valor: 20.01, quantidade: 1 }] })).toBe(
        MOTIVO_RECUSA_LINK.excedeRestante,
      );
    });

    it('does NOT double count a pending payment on a link that is still OPEN', () => {
      // The open link's pending payment is already inside valor × restantes (40):
      // restante 100 − open exposure 40 = 60 fits, and one centavo more does not.
      for (const status of [
        STATUS_PAGAMENTO.pendente,
        STATUS_PAGAMENTO.em_revisao,
        STATUS_PAGAMENTO.em_processo_aprovacao,
      ]) {
        const aberto = entrada({
          links: [link('a', { valorCobrado: 40 })],
          pagamentos: [emTransito(status)],
        });
        expect(
          avaliarElegibilidade({ ...aberto, novos: [{ valor: 60, quantidade: 1 }] }),
        ).toBeNull();
        expect(avaliarElegibilidade({ ...aberto, novos: [{ valor: 60.01, quantidade: 1 }] })).toBe(
          MOTIVO_RECUSA_LINK.excedeRestante,
        );
      }
    });

    it('counts nothing for a pending payment that names no STORED link of the pedido', () => {
      for (const sobra of [{ linkPagamentoId: null }, { linkPagamentoId: 'naoGuardado' }]) {
        const e = entrada({
          links: [expirado],
          pagamentos: [emTransito(STATUS_PAGAMENTO.pendente, sobra)],
        });
        expect(avaliarElegibilidade(e), JSON.stringify(sobra)).toBeNull();
      }
    });
  });

  it('refuses a malformed entry in the batch instead of letting NaN through', () => {
    for (const novo of [
      { valor: Number.NaN, quantidade: 1 },
      { valor: Number.POSITIVE_INFINITY, quantidade: 1 },
      { valor: 0, quantidade: 1 },
      { valor: -10, quantidade: 1 },
      { valor: 0.004, quantidade: 1 },
      { valor: 50, quantidade: 0 },
      { valor: 50, quantidade: 1.5 },
      { valor: 50, quantidade: Number.NaN },
    ]) {
      expect(avaliarElegibilidade(entrada({ novos: [novo] })), JSON.stringify(novo)).toBe(
        MOTIVO_RECUSA_LINK.excedeRestante,
      );
    }
  });
});

/** A stored NF-e, raw. `ultima_modificacao` is omitted when `carimbo` is undefined. */
function nfe(id: string, estado: unknown, carimbo?: unknown) {
  return {
    id,
    data: carimbo === undefined ? { estado } : { estado, ultima_modificacao: carimbo },
  };
}

describe('nfeMaisRecenteTravaPagamentos', () => {
  const t = (nfes: ReturnType<typeof nfe>[], estado: EstadoPedido) =>
    nfeMaisRecenteTravaPagamentos(nfes, estado);

  it('is false with no NF-e at all', () => {
    expect(t([], ESTADO_PEDIDO.carrinho)).toBe(false);
  });

  it('locks on an aprovada NF-e only outside the carve-out estados', () => {
    const aprovada = [nfe('n1', ESTADO_NFE.aprovada, 1000)];
    // The editor's own carve-outs (iniciado / aguardandoConfirmacaoDePagamento / cancelado).
    expect(t(aprovada, ESTADO_PEDIDO.iniciado)).toBe(false);
    expect(t(aprovada, ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento)).toBe(false);
    expect(t(aprovada, ESTADO_PEDIDO.cancelado)).toBe(false);
    // Every other estado a link can be generated from is locked.
    expect(t(aprovada, ESTADO_PEDIDO.carrinho)).toBe(true);
    expect(t(aprovada, ESTADO_PEDIDO.escolhendoFormaDePagamento)).toBe(true);
    expect(t(aprovada, ESTADO_PEDIDO.pagamentoNaoRealizado)).toBe(true);
  });

  it('locks a cancelada or numeração-inutilizada NF-e in EVERY estado', () => {
    for (const estadoNfe of [ESTADO_NFE.cancelada, ESTADO_NFE.numeracaoInutilizada]) {
      for (const estado of [
        ESTADO_PEDIDO.iniciado,
        ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      ]) {
        expect(t([nfe('n1', estadoNfe, 1000)], estado), `${estadoNfe}/${estado}`).toBe(true);
      }
    }
  });

  it('does not lock on an NF-e that is not final', () => {
    const naoFinais: EstadoNFe[] = [
      ESTADO_NFE.gerado,
      ESTADO_NFE.enviando,
      ESTADO_NFE.aguardandoResposta,
      ESTADO_NFE.rejeitada,
      ESTADO_NFE.error,
    ];
    for (const estadoNfe of naoFinais) {
      expect(t([nfe('n1', estadoNfe, 1000)], ESTADO_PEDIDO.carrinho), estadoNfe).toBe(false);
    }
  });

  it('follows the NEWEST NF-e, not the worst one', () => {
    // An old cancelled attempt followed by a fresh, unsent NF-e: the pedido is editable again.
    expect(
      t(
        [nfe('velha', ESTADO_NFE.cancelada, 1000), nfe('nova', ESTADO_NFE.gerado, 2000)],
        ESTADO_PEDIDO.carrinho,
      ),
    ).toBe(false);
    // ...and the reverse order locks.
    expect(
      t(
        [nfe('velha', ESTADO_NFE.gerado, 1000), nfe('nova', ESTADO_NFE.cancelada, 2000)],
        ESTADO_PEDIDO.carrinho,
      ),
    ).toBe(true);
    // The order of the array is irrelevant.
    expect(
      t(
        [nfe('nova', ESTADO_NFE.cancelada, 2000), nfe('velha', ESTADO_NFE.gerado, 1000)],
        ESTADO_PEDIDO.carrinho,
      ),
    ).toBe(true);
  });

  it('orders a millisecond stamp and a microsecond stamp on ONE scale', () => {
    // 1.7e15 µs is 1.7e12 ms: older than 1.8e12 ms, though numerically far larger.
    const emMicros = nfe('micros', ESTADO_NFE.cancelada, 1_700_000_000_000_000);
    const emMillis = nfe('millis', ESTADO_NFE.gerado, 1_800_000_000_000);
    expect(t([emMicros, emMillis], ESTADO_PEDIDO.carrinho)).toBe(false);
    // Near-miss: the microsecond stamp really is the newer one.
    const maisNovaEmMicros = nfe('micros', ESTADO_NFE.cancelada, 1_900_000_000_000_000);
    expect(t([maisNovaEmMicros, emMillis], ESTADO_PEDIDO.carrinho)).toBe(true);
  });

  it('treats a row with no readable stamp as the oldest', () => {
    expect(
      t(
        [nfe('sem', ESTADO_NFE.cancelada), nfe('com', ESTADO_NFE.gerado, 1000)],
        ESTADO_PEDIDO.carrinho,
      ),
    ).toBe(false);
    expect(
      t(
        [nfe('sem', ESTADO_NFE.gerado), nfe('com', ESTADO_NFE.cancelada, 1000)],
        ESTADO_PEDIDO.carrinho,
      ),
    ).toBe(true);
    expect(
      t(
        [nfe('lixo', ESTADO_NFE.cancelada, 'ontem'), nfe('com', ESTADO_NFE.gerado, 1000)],
        ESTADO_PEDIDO.carrinho,
      ),
    ).toBe(false);
  });

  it('fails closed on a TIE for newest: any of the tied rows locking is enough', () => {
    expect(
      t(
        [nfe('a', ESTADO_NFE.gerado, 1000), nfe('b', ESTADO_NFE.aprovada, 1000)],
        ESTADO_PEDIDO.carrinho,
      ),
    ).toBe(true);
    // Near-miss: tied and neither locks.
    expect(
      t(
        [nfe('a', ESTADO_NFE.gerado, 1000), nfe('b', ESTADO_NFE.rejeitada, 1000)],
        ESTADO_PEDIDO.carrinho,
      ),
    ).toBe(false);
    // Every row unstamped is a tie too.
    expect(
      t([nfe('a', ESTADO_NFE.gerado), nfe('b', ESTADO_NFE.cancelada)], ESTADO_PEDIDO.carrinho),
    ).toBe(true);
  });

  it('fails closed on a newest NF-e whose estado is present but unreadable', () => {
    expect(
      t([nfe('a', 'zzz', 2000), nfe('b', ESTADO_NFE.gerado, 1000)], ESTADO_PEDIDO.carrinho),
    ).toBe(true);
    expect(t([nfe('a', 42, 2000)], ESTADO_PEDIDO.carrinho)).toBe(true);
    // Near-miss: the unreadable row is OLDER than a readable, non-locking one — it is not the newest.
    expect(
      t([nfe('a', 'zzz', 1000), nfe('b', ESTADO_NFE.gerado, 2000)], ESTADO_PEDIDO.carrinho),
    ).toBe(false);
  });

  it('reads an absent estado as no lock (the schema default is gerado)', () => {
    expect(t([nfe('a', undefined, 1000)], ESTADO_PEDIDO.carrinho)).toBe(false);
    expect(t([nfe('a', null, 1000)], ESTADO_PEDIDO.carrinho)).toBe(false);
    // A raw snapshot can carry no data at all; the reader must not throw.
    expect(t([{ id: 'a', data: null as never }], ESTADO_PEDIDO.carrinho)).toBe(false);
  });
});
