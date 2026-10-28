import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  STATUS_PAGAMENTO,
  estadoPedidoSchema,
  type EstadoPedido,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { pedidoAmazon } from '../testing/pedidoWireAmazon';
import {
  FULFILLMENT_STATUS_AMAZON,
  PREFIXO_ERRO_AMAZON,
  TEXTO_ERRO_AMAZON,
  alvoCanceladoAmazon,
  alvoEstadoPedidoAmazon,
  TITULO_BLOQUEIO_AMAZON,
  aprovadoAmazon,
  ehErroAfnAmazon,
  ehErroBloqueioAmazon,
  ehStatusConhecidoAmazon,
  estadoAmazonAplicavel,
  governadoAmazon,
  lerPagamentoArmazenadoAmazon,
  lerResumoArmazenadoAmazon,
  type ContextoEstadoAmazon,
  type PagamentoArmazenadoAmazon,
  type ResumoArmazenadoAmazon,
} from './estadoPedidoAmazon';

function resumo(over: Partial<ResumoArmazenadoAmazon> = {}): ResumoArmazenadoAmazon {
  return {
    estado: ESTADO_PEDIDO.pago,
    error: null,
    marketplaceTipo: 'amazon',
    marketplaceStatus: 'UNSHIPPED',
    impresso: false,
    congelado: false,
    freteEstado: ESTADO_FRETE.iniciado,
    ...over,
  };
}

function contexto(
  armazenado: ResumoArmazenadoAmazon | null,
  pagamento: PagamentoArmazenadoAmazon = 'ausente',
  fora = false,
): ContextoEstadoAmazon {
  return { armazenado, pagamentoArmazenado: pagamento, mercadoriaFora: fora };
}

const NOSSO_ERRO = `${PREFIXO_ERRO_AMAZON}itens divergentes do pedido na Amazon: L1`;

describe('the stored readers', () => {
  it('impresso reads BOTH print fields: foiImpresso alone, dtImpressao alone, neither', () => {
    expect(lerResumoArmazenadoAmazon({ estado: 'pago', foiImpresso: true }).impresso).toBe(true);
    expect(
      lerResumoArmazenadoAmazon({ estado: 'pago', foiImpresso: false, dtImpressao: 1_000_000 })
        .impresso,
    ).toBe(true);
    expect(
      lerResumoArmazenadoAmazon({ estado: 'pago', foiImpresso: false, dtImpressao: null }).impresso,
    ).toBe(false);
    expect(lerResumoArmazenadoAmazon({ estado: 'pago' }).impresso).toBe(false);
  });

  it('reads tolerantly: an estado outside the enum is null, hasUserInteraction only when true', () => {
    const r = lerResumoArmazenadoAmazon({
      estado: 'qualquer',
      hasUserInteraction: 'true',
      marketplace: { tipo: 'amazon', status: 'UNSHIPPED' },
    });
    expect(r).toMatchObject({
      estado: null,
      congelado: false,
      marketplaceTipo: 'amazon',
      marketplaceStatus: 'UNSHIPPED',
      freteEstado: null,
    });
    expect(
      lerResumoArmazenadoAmazon({
        estado: 'pago',
        hasUserInteraction: true,
        freteInicial: { estado: 'postado' },
      }),
    ).toMatchObject({
      congelado: true,
      freteEstado: 'postado',
    });
  });

  it('★ the pagamento: absent, a member, or unreadable — read from `status_pagamento`, the field the schema, the legacy corpus and PR 6 write', () => {
    expect(lerPagamentoArmazenadoAmazon(null)).toBe('ausente');
    expect(lerPagamentoArmazenadoAmazon({ status_pagamento: 4 })).toBe(STATUS_PAGAMENTO.aprovado);
    expect(lerPagamentoArmazenadoAmazon({ status_pagamento: 8 })).toBe(STATUS_PAGAMENTO.estornado);
    expect(lerPagamentoArmazenadoAmazon({ status_pagamento: '4' })).toBe('ilegivel');
    expect(lerPagamentoArmazenadoAmazon({})).toBe('ilegivel');
    // NEAR-MISS: a field named `status` is no pagamento status (5-c read it by mistake).
    expect(lerPagamentoArmazenadoAmazon({ status: 4 })).toBe('ilegivel');
  });
});

describe('governed estados and aprovadoAmazon', () => {
  it('governs the four estados and OUR error only', () => {
    for (const estado of estadoPedidoSchema.options) {
      const esperado = [
        'aguardandoConfirmacaoDePagamento',
        'pago',
        'cancelado',
        'estornadoIntegralmente',
      ].includes(estado);
      expect(governadoAmazon({ estado, error: null }), estado).toBe(esperado);
    }
    expect(governadoAmazon({ estado: ESTADO_PEDIDO.error, error: NOSSO_ERRO })).toBe(true);
    expect(governadoAmazon({ estado: ESTADO_PEDIDO.error, error: 'Rejeição 539 da SEFAZ' })).toBe(
      false,
    );
  });

  it('our own NON-block error counts as approved ONLY when the stored marketplace.status is an approved one (NEAR-MISS pair)', () => {
    const naoBloqueio = TEXTO_ERRO_AMAZON.statusDesconhecido;
    expect(
      aprovadoAmazon(resumo({ estado: 'error', error: naoBloqueio, marketplaceStatus: null })),
    ).toBe(false);
    expect(
      aprovadoAmazon(
        resumo({ estado: 'error', error: naoBloqueio, marketplaceStatus: 'UNSHIPPED' }),
      ),
    ).toBe(true);
    expect(aprovadoAmazon(resumo({ estado: 'aguardandoConfirmacaoDePagamento' }))).toBe(false);
    expect(aprovadoAmazon(resumo({ estado: 'pago' }))).toBe(true);
    expect(aprovadoAmazon(resumo({ estado: 'finalizado' }))).toBe(true);
    expect(aprovadoAmazon(resumo({ estado: null }))).toBe(true);
  });

  it('★ (PR 5-f) our own error with a stored PENDING or PENDING_AVAILABILITY was NEVER approved — what a create without fulfilledBy stores; NEAR-MISS: the same error with UNSHIPPED is', () => {
    // The state a PENDING create without fulfilledBy writes (and every later read without it keeps).
    const criado = alvoEstadoPedidoAmazon(
      pedidoAmazon({ status: 'PENDING', por: null }),
      contexto(null),
    );
    expect(criado.alvo).toMatchObject({
      estado: ESTADO_PEDIDO.error,
      erro: TEXTO_ERRO_AMAZON.logisticaDesconhecida,
    });
    // Every known status, decided by the stored status alone (every NON-block
    // text of ours); a block text is approved whatever the status (PR 5-f).
    const aprovados = new Set<string>(['UNSHIPPED', 'PARTIALLY_SHIPPED', 'SHIPPED']);
    for (const error of Object.values(TEXTO_ERRO_AMAZON)) {
      for (const status of Object.values(FULFILLMENT_STATUS_AMAZON)) {
        expect(
          aprovadoAmazon(resumo({ estado: 'error', error, marketplaceStatus: status })),
          `${error} / ${status}`,
        ).toBe(aprovados.has(status));
        expect(
          aprovadoAmazon(resumo({ estado: 'error', error: NOSSO_ERRO, marketplaceStatus: status })),
          `block / ${status}`,
        ).toBe(true);
      }
    }
    expect(
      aprovadoAmazon(
        resumo({
          estado: 'error',
          error: TEXTO_ERRO_AMAZON.logisticaDesconhecida,
          marketplaceStatus: 'PENDING',
        }),
      ),
    ).toBe(false);
    expect(
      aprovadoAmazon(
        resumo({
          estado: 'error',
          error: TEXTO_ERRO_AMAZON.logisticaDesconhecida,
          marketplaceStatus: 'PENDING_AVAILABILITY',
        }),
      ),
    ).toBe(false);
    // NEAR-MISS: the same stored error once an UNSHIPPED read was stored over it.
    expect(
      aprovadoAmazon(
        resumo({
          estado: 'error',
          error: TEXTO_ERRO_AMAZON.logisticaDesconhecida,
          marketplaceStatus: 'UNSHIPPED',
        }),
      ),
    ).toBe(true);
    // NEAR-MISS: a stored PENDING beside an estado that is not our error answers by the estado.
    expect(
      aprovadoAmazon(
        resumo({ estado: 'aguardandoConfirmacaoDePagamento', marketplaceStatus: 'PENDING' }),
      ),
    ).toBe(false);
    expect(aprovadoAmazon(resumo({ estado: 'pago', marketplaceStatus: 'PENDING' }))).toBe(true);
  });

  it('ehStatusConhecidoAmazon: every FULFILLMENT_STATUS_AMAZON member, EXACTLY; NEAR-MISS: a case or whitespace variant, INVOICE_UNCONFIRMED, blank, null', () => {
    for (const status of Object.values(FULFILLMENT_STATUS_AMAZON)) {
      expect(ehStatusConhecidoAmazon(status), status).toBe(true);
    }
    for (const status of [
      'unshipped',
      'Unshipped',
      ' UNSHIPPED',
      'UNSHIPPED ',
      'INVOICE_UNCONFIRMED',
      '',
      '   ',
      null,
    ]) {
      expect(ehStatusConhecidoAmazon(status), String(status)).toBe(false);
    }
  });

  it('the table raises status-desconhecido exactly for what ehStatusConhecidoAmazon refuses (one meaning of "known")', () => {
    for (const status of [
      ...Object.values(FULFILLMENT_STATUS_AMAZON),
      'unshipped',
      'INVOICE_UNCONFIRMED',
    ]) {
      const avisos = alvoEstadoPedidoAmazon(pedidoAmazon({ status }), contexto(resumo())).avisos;
      expect(avisos.includes('status-desconhecido'), status).toBe(!ehStatusConhecidoAmazon(status));
    }
  });

  it('★ (PR 5-f) ehErroAfnAmazon: exactly estado error + the AFN text — the state an AFN create writes and the table keeps; NEAR-MISS: another text of ours, a case or whitespace variant, the text beside another estado, a foreign error', () => {
    expect(ehErroAfnAmazon({ estado: ESTADO_PEDIDO.error, error: TEXTO_ERRO_AMAZON.afn })).toBe(
      true,
    );
    // What the table writes on an AFN create, and keeps on the later AFN or logistics-less reads.
    const criado = alvoEstadoPedidoAmazon(pedidoAmazon({ por: 'AMAZON' }), contexto(null)).alvo;
    expect(criado).toMatchObject({ estado: ESTADO_PEDIDO.error, erro: TEXTO_ERRO_AMAZON.afn });
    const guardado = resumo({ estado: ESTADO_PEDIDO.error, error: TEXTO_ERRO_AMAZON.afn });
    for (const por of ['AMAZON', null]) {
      const alvo = alvoEstadoPedidoAmazon(pedidoAmazon({ por }), contexto(guardado)).alvo;
      expect(alvo.tipo === 'manter' || alvo.erro === TEXTO_ERRO_AMAZON.afn, String(por)).toBe(true);
    }
    for (const [nome, armazenado] of [
      [
        'another text of ours',
        { estado: ESTADO_PEDIDO.error, error: TEXTO_ERRO_AMAZON.naoAtendivel },
      ],
      ['the block text', { estado: ESTADO_PEDIDO.error, error: NOSSO_ERRO }],
      ['a trailing space', { estado: ESTADO_PEDIDO.error, error: `${TEXTO_ERRO_AMAZON.afn} ` }],
      ['upper case', { estado: ESTADO_PEDIDO.error, error: TEXTO_ERRO_AMAZON.afn.toUpperCase() }],
      ['a prefix of it', { estado: ESTADO_PEDIDO.error, error: PREFIXO_ERRO_AMAZON }],
      ['beside pago', { estado: ESTADO_PEDIDO.pago, error: TEXTO_ERRO_AMAZON.afn }],
      ['beside cancelado', { estado: ESTADO_PEDIDO.cancelado, error: TEXTO_ERRO_AMAZON.afn }],
      ['a foreign error', { estado: ESTADO_PEDIDO.error, error: 'Rejeição 539 da SEFAZ' }],
      ['no text', { estado: ESTADO_PEDIDO.error, error: null }],
      ['an estado outside the enum', { estado: null, error: TEXTO_ERRO_AMAZON.afn }],
    ] as const) {
      expect(ehErroAfnAmazon(armazenado), nome).toBe(false);
    }
  });
});

describe('alvoEstadoPedidoAmazon — the table, one row per status, create and update', () => {
  const casos: readonly [
    string | null,
    EstadoPedido | 'erro' | 'cancel' | 'manter',
    EstadoPedido | 'manter' | 'cancel',
  ][] = [
    // [status, create target, update target over a stored pago]
    [
      'PENDING_AVAILABILITY',
      'aguardandoConfirmacaoDePagamento',
      'aguardandoConfirmacaoDePagamento',
    ],
    ['PENDING', 'aguardandoConfirmacaoDePagamento', 'aguardandoConfirmacaoDePagamento'],
    ['UNSHIPPED', 'pago', 'pago'],
    ['PARTIALLY_SHIPPED', 'pago', 'pago'],
    ['SHIPPED', 'pago', 'pago'],
    ['CANCELLED', 'cancel', 'cancel'],
    ['UNFULFILLABLE', 'erro', 'manter'],
    ['INVOICE_UNCONFIRMED', 'erro', 'manter'],
    ['', 'erro', 'manter'],
    [null, 'erro', 'manter'],
  ];
  for (const [status, criacao, atualizacao] of casos) {
    it(`${String(status)}: create → ${criacao}, update (stored pago) → ${atualizacao}`, () => {
      const order = pedidoAmazon({ status });
      const cria = alvoEstadoPedidoAmazon(order, contexto(null));
      const atualiza = alvoEstadoPedidoAmazon(order, contexto(resumo()));
      if (criacao === 'erro') expect(cria.alvo).toMatchObject({ tipo: 'estado', estado: 'error' });
      else if (criacao === 'cancel')
        expect(cria.alvo).toEqual({ tipo: 'estado', estado: 'cancelado', erro: null });
      else expect(cria.alvo).toEqual({ tipo: 'estado', estado: criacao, erro: null });
      if (atualizacao === 'manter') expect(atualiza.alvo).toEqual({ tipo: 'manter' });
      else if (atualizacao === 'cancel')
        expect(atualiza.alvo).toEqual({ tipo: 'estado', estado: 'cancelado', erro: null });
      else expect(atualiza.alvo).toEqual({ tipo: 'estado', estado: atualizacao, erro: null });
    });
  }

  it('an unknown or absent status raises status-desconhecido on both; UNFULFILLABLE files logistica-amazon', () => {
    for (const status of ['INVOICE_UNCONFIRMED', '', null]) {
      const order = pedidoAmazon({ status });
      expect(alvoEstadoPedidoAmazon(order, contexto(null)).avisos).toContain('status-desconhecido');
      expect(alvoEstadoPedidoAmazon(order, contexto(resumo())).avisos).toContain(
        'status-desconhecido',
      );
    }
    const criado = alvoEstadoPedidoAmazon(
      pedidoAmazon({ status: 'INVOICE_UNCONFIRMED' }),
      contexto(null),
    );
    expect(criado.alvo).toEqual({
      tipo: 'estado',
      estado: 'error',
      erro: `${TEXTO_ERRO_AMAZON.statusDesconhecido}: INVOICE_UNCONFIRMED`,
    });
    const naoAtendivel = alvoEstadoPedidoAmazon(
      pedidoAmazon({ status: 'UNFULFILLABLE' }),
      contexto(resumo({ estado: 'aguardandoConfirmacaoDePagamento' })),
    );
    expect(naoAtendivel).toMatchObject({
      alvo: { estado: 'error', erro: TEXTO_ERRO_AMAZON.naoAtendivel },
      incidentes: ['logistica-amazon'],
    });
  });

  it('the ceiling is pago: no row ever targets finalizado', () => {
    for (const status of ['UNSHIPPED', 'PARTIALLY_SHIPPED', 'SHIPPED']) {
      expect(
        alvoEstadoPedidoAmazon(pedidoAmazon({ status }), contexto(resumo())).alvo,
      ).not.toMatchObject({ estado: 'finalizado' });
    }
  });
});

describe('fulfilledBy', () => {
  it('create + AMAZON ⇒ error + logistica-amazon', () => {
    const d = alvoEstadoPedidoAmazon(pedidoAmazon({ por: 'AMAZON' }), contexto(null));
    expect(d).toEqual({
      alvo: { tipo: 'estado', estado: 'error', erro: TEXTO_ERRO_AMAZON.afn },
      incidentes: ['logistica-amazon'],
      avisos: [],
    });
  });

  it('NEAR-MISS against create: stored pago + freight postado + a read without fulfillment ⇒ keep + logistica-desconhecida', () => {
    const order = pedidoAmazon({ semFulfillment: true });
    const atualiza = alvoEstadoPedidoAmazon(
      order,
      contexto(resumo({ freteEstado: 'postado' }), 'ausente', true),
    );
    expect(atualiza.alvo).toEqual({ tipo: 'manter' });
    expect(atualiza.avisos).toContain('logistica-desconhecida');
    const cria = alvoEstadoPedidoAmazon(order, contexto(null));
    expect(cria.alvo).toMatchObject({ tipo: 'estado', estado: 'error' });
    expect(cria.avisos).toContain('logistica-desconhecida');
  });

  it('an absent fulfilledBy on UPDATE never moves the estado (UNSHIPPED included)', () => {
    const d = alvoEstadoPedidoAmazon(pedidoAmazon({ por: null }), contexto(resumo()));
    expect(d.alvo).toEqual({ tipo: 'manter' });
    expect(d.avisos).toEqual(['logistica-desconhecida']);
  });

  it('stored pago + AMAZON ⇒ kept + logistica-amazon; stored PENDING + AMAZON ⇒ error', () => {
    expect(alvoEstadoPedidoAmazon(pedidoAmazon({ por: 'AMAZON' }), contexto(resumo()))).toEqual({
      alvo: { tipo: 'manter' },
      incidentes: ['logistica-amazon'],
      avisos: [],
    });
    expect(
      alvoEstadoPedidoAmazon(
        pedidoAmazon({ por: 'AMAZON', status: 'PENDING' }),
        contexto(resumo({ estado: 'aguardandoConfirmacaoDePagamento' })),
      ).alvo,
    ).toMatchObject({ estado: 'error', erro: TEXTO_ERRO_AMAZON.afn });
  });
});

describe('alvoCanceladoAmazon — the ONE CANCELLED predicate (stored estado × pagamento × freight)', () => {
  it('no pagamento ⇒ cancelado, a stored pago without one included (the legacy shape)', () => {
    expect(alvoCanceladoAmazon(contexto(resumo({ estado: 'pago' }), 'ausente')).alvo).toMatchObject(
      { estado: 'cancelado' },
    );
    expect(
      alvoCanceladoAmazon(
        contexto(resumo({ estado: 'aguardandoConfirmacaoDePagamento' }), 'ausente'),
      ).alvo,
    ).toMatchObject({ estado: 'cancelado' });
  });

  it('a stored pagamento aprovado or estornado ⇒ estornadoIntegralmente (the pedido alone would say cancelado)', () => {
    expect(alvoCanceladoAmazon(contexto(resumo(), STATUS_PAGAMENTO.aprovado)).alvo).toMatchObject({
      estado: 'estornadoIntegralmente',
    });
    expect(alvoCanceladoAmazon(contexto(resumo(), STATUS_PAGAMENTO.estornado)).alvo).toMatchObject({
      estado: 'estornadoIntegralmente',
    });
  });

  it('an off-ladder pagamento (em_disputa, recusado, unreadable) ⇒ cancelado + pagamento-divergente', () => {
    for (const pag of [
      STATUS_PAGAMENTO.em_disputa,
      STATUS_PAGAMENTO.recusado,
      'ilegivel',
    ] as const) {
      expect(alvoCanceladoAmazon(contexto(resumo(), pag))).toEqual({
        alvo: { tipo: 'estado', estado: 'cancelado', erro: null },
        incidentes: ['pagamento-divergente'],
        avisos: [],
      });
    }
  });

  it('goods out (postado, objetoExtraviado, suspenso, aguardandoRetirada, devolvido) ⇒ kept + cancelado-apos-envio', () => {
    const d = alvoCanceladoAmazon(contexto(resumo(), STATUS_PAGAMENTO.aprovado, true));
    expect(d).toEqual({
      alvo: { tipo: 'manter' },
      incidentes: ['cancelado-apos-envio'],
      avisos: [],
    });
  });

  it('a fora-da-escada stored estado ⇒ kept + cancelado-apos-envio', () => {
    for (const estado of ['finalizado', 'emProcessamento', 'fraude'] as const) {
      expect(alvoCanceladoAmazon(contexto(resumo({ estado }), 'ausente')).alvo).toEqual({
        tipo: 'manter',
      });
    }
    expect(
      alvoCanceladoAmazon(
        contexto(resumo({ estado: 'error', error: 'nota de um operador' }), 'ausente'),
      ).alvo,
    ).toEqual({ tipo: 'manter' });
  });
});

describe('estadoAmazonAplicavel — the ladder', () => {
  const pago = { tipo: 'estado', estado: ESTADO_PEDIDO.pago, erro: null } as const;
  const aguardando = {
    tipo: 'estado',
    estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    erro: null,
  } as const;

  it('pago + PENDING ⇒ regressivo; PENDING → pago written', () => {
    expect(estadoAmazonAplicavel(resumo(), aguardando, { maisNovo: true })).toEqual({
      escrever: false,
      motivo: 'regressivo',
    });
    expect(
      estadoAmazonAplicavel(resumo({ estado: 'aguardandoConfirmacaoDePagamento' }), pago, {
        maisNovo: false,
      }),
    ).toEqual({
      escrever: true,
      estado: 'pago',
      ressuscitado: false,
    });
  });

  it('NEAR-MISS pair: cancelado with stored status CANCELLED + strictly newer ⇒ ressuscitado; the same with stored status UNSHIPPED ⇒ refused', () => {
    expect(
      estadoAmazonAplicavel(resumo({ estado: 'cancelado', marketplaceStatus: 'CANCELLED' }), pago, {
        maisNovo: true,
      }),
    ).toEqual({
      escrever: true,
      estado: 'pago',
      ressuscitado: true,
    });
    expect(
      estadoAmazonAplicavel(resumo({ estado: 'cancelado', marketplaceStatus: 'UNSHIPPED' }), pago, {
        maisNovo: true,
      }),
    ).toEqual({
      escrever: false,
      motivo: 'terminal',
    });
  });

  it('an EQUAL clock never resurrects, even when Amazon had cancelled', () => {
    expect(
      estadoAmazonAplicavel(
        resumo({ estado: 'estornadoIntegralmente', marketplaceStatus: 'CANCELLED' }),
        pago,
        { maisNovo: false },
      ),
    ).toEqual({ escrever: false, motivo: 'terminal' });
  });

  it('every off-ladder stored estado stays unmoved', () => {
    for (const estado of [
      'finalizado',
      'emProcessamento',
      'estornadoParcialmente',
      'processandoCancelamento',
      'fraude',
      'emAnalise',
    ] as const) {
      expect(estadoAmazonAplicavel(resumo({ estado }), pago, { maisNovo: true }), estado).toEqual({
        escrever: false,
        motivo: 'fora-da-escada',
      });
    }
    expect(
      estadoAmazonAplicavel(resumo({ estado: 'error', error: 'Rejeição 539' }), pago, {
        maisNovo: true,
      }),
    ).toEqual({
      escrever: false,
      motivo: 'fora-da-escada',
    });
    expect(estadoAmazonAplicavel(resumo({ estado: null }), pago, { maisNovo: true })).toEqual({
      escrever: false,
      motivo: 'fora-da-escada',
    });
  });

  it('our own error is left for the table target; terminal ↔ terminal moves; manter and the same estado write nothing', () => {
    expect(
      estadoAmazonAplicavel(resumo({ estado: 'error', error: NOSSO_ERRO }), pago, {
        maisNovo: false,
      }),
    ).toMatchObject({ escrever: true });
    expect(
      estadoAmazonAplicavel(
        resumo({ estado: 'cancelado' }),
        { tipo: 'estado', estado: 'estornadoIntegralmente', erro: null },
        { maisNovo: false },
      ),
    ).toMatchObject({ escrever: true, ressuscitado: false });
    expect(estadoAmazonAplicavel(resumo(), { tipo: 'manter' }, { maisNovo: true })).toEqual({
      escrever: false,
      motivo: 'manter',
    });
    expect(estadoAmazonAplicavel(resumo(), pago, { maisNovo: true })).toEqual({
      escrever: false,
      motivo: 'sem-mudanca',
    });
    expect(estadoAmazonAplicavel(null, aguardando, { maisNovo: true })).toMatchObject({
      escrever: true,
      estado: aguardando.estado,
    });
  });
});

describe('★ PR 5-f — our D17 block error is itself the approval: the lock and the pago rung survive a known pre-approval status', () => {
  const BLOQUEIOS = [
    `${PREFIXO_ERRO_AMAZON}${TITULO_BLOQUEIO_AMAZON.itens}: L1`,
    `${PREFIXO_ERRO_AMAZON}${TITULO_BLOQUEIO_AMAZON.cancelamentoParcial}: L2, L3 (+4)`,
    `${PREFIXO_ERRO_AMAZON}${TITULO_BLOQUEIO_AMAZON.pagamento}`,
    `${PREFIXO_ERRO_AMAZON}${TITULO_BLOQUEIO_AMAZON.itens}`,
  ];
  const aguardando = {
    tipo: 'estado',
    estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    erro: null,
  } as const;
  const pago = { tipo: 'estado', estado: ESTADO_PEDIDO.pago, erro: null } as const;

  it('ehErroBloqueioAmazon recognises exactly our three block titles, alone or with ": <ids>"', () => {
    for (const error of BLOQUEIOS) {
      expect(ehErroBloqueioAmazon({ estado: ESTADO_PEDIDO.error, error }), error).toBe(true);
    }
  });

  it('NEAR-MISS: our other texts, a stray space, another case or separator, a foreign text, and a block text beside another estado are NOT a block', () => {
    const base = `${PREFIXO_ERRO_AMAZON}${TITULO_BLOQUEIO_AMAZON.itens}`;
    for (const error of [
      ...Object.values(TEXTO_ERRO_AMAZON),
      `${base} `,
      ` ${base}`,
      `${base}:L1`,
      `${base} - L1`,
      `${base}s: L1`,
      base.toUpperCase(),
      `${TITULO_BLOQUEIO_AMAZON.itens}: L1`,
      'Rejeição 539',
      null,
    ]) {
      expect(ehErroBloqueioAmazon({ estado: ESTADO_PEDIDO.error, error }), String(error)).toBe(
        false,
      );
    }
    expect(ehErroBloqueioAmazon({ estado: ESTADO_PEDIDO.pago, error: `${base}: L1` })).toBe(false);
  });

  it('aprovadoAmazon: a block text is approved whatever the stored status (PENDING, unknown, null); NEAR-MISS: our logistics text beside the same statuses is not', () => {
    for (const marketplaceStatus of [
      'PENDING',
      'PENDING_AVAILABILITY',
      'INVOICE_UNCONFIRMED',
      null,
    ]) {
      for (const error of BLOQUEIOS) {
        expect(
          aprovadoAmazon(resumo({ estado: 'error', error, marketplaceStatus })),
          `${error} / ${String(marketplaceStatus)}`,
        ).toBe(true);
      }
      expect(
        aprovadoAmazon(
          resumo({
            estado: 'error',
            error: TEXTO_ERRO_AMAZON.logisticaDesconhecida,
            marketplaceStatus,
          }),
        ),
        String(marketplaceStatus),
      ).toBe(false);
    }
  });

  it('the ladder: our APPROVED error sits on the pago rung, so a pre-approval target is regressivo (the text and the lock stay); it still moves to pago or a terminal', () => {
    for (const armazenado of [
      resumo({ estado: 'error', error: BLOQUEIOS[0] ?? '', marketplaceStatus: 'PENDING' }),
      resumo({ estado: 'error', error: BLOQUEIOS[1] ?? '', marketplaceStatus: 'UNSHIPPED' }),
      resumo({
        estado: 'error',
        error: TEXTO_ERRO_AMAZON.logisticaDesconhecida,
        marketplaceStatus: 'UNSHIPPED',
      }),
    ]) {
      const nome = `${String(armazenado.error)} / ${String(armazenado.marketplaceStatus)}`;
      expect(estadoAmazonAplicavel(armazenado, aguardando, { maisNovo: true }), nome).toEqual({
        escrever: false,
        motivo: 'regressivo',
      });
      expect(estadoAmazonAplicavel(armazenado, pago, { maisNovo: true }), nome).toMatchObject({
        escrever: true,
        estado: ESTADO_PEDIDO.pago,
      });
      expect(
        estadoAmazonAplicavel(
          armazenado,
          { tipo: 'estado', estado: ESTADO_PEDIDO.cancelado, erro: null },
          { maisNovo: false },
        ),
        nome,
      ).toMatchObject({ escrever: true, estado: ESTADO_PEDIDO.cancelado });
    }
  });

  it('NEAR-MISS: our error that was NEVER approved (a create without fulfilledBy, stored PENDING) has no rung — PENDING moves it to aguardandoConfirmacaoDePagamento, as before', () => {
    for (const error of [
      TEXTO_ERRO_AMAZON.logisticaDesconhecida,
      TEXTO_ERRO_AMAZON.statusDesconhecido,
    ]) {
      expect(
        estadoAmazonAplicavel(
          resumo({ estado: 'error', error, marketplaceStatus: 'PENDING' }),
          aguardando,
          { maisNovo: true },
        ),
        error,
      ).toMatchObject({ escrever: true, estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento });
    }
  });
});
