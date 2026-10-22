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
  PREFIXO_ERRO_AMAZON,
  TEXTO_ERRO_AMAZON,
  alvoCanceladoAmazon,
  alvoEstadoPedidoAmazon,
  aprovadoAmazon,
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

  it('the pagamento: absent, a member, or unreadable', () => {
    expect(lerPagamentoArmazenadoAmazon(null)).toBe('ausente');
    expect(lerPagamentoArmazenadoAmazon({ status: 4 })).toBe(STATUS_PAGAMENTO.aprovado);
    expect(lerPagamentoArmazenadoAmazon({ status: '4' })).toBe('ilegivel');
    expect(lerPagamentoArmazenadoAmazon({})).toBe('ilegivel');
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

  it('our own error counts as approved ONLY when the stored marketplace.status is an approved one (NEAR-MISS pair)', () => {
    expect(
      aprovadoAmazon(resumo({ estado: 'error', error: NOSSO_ERRO, marketplaceStatus: null })),
    ).toBe(false);
    expect(
      aprovadoAmazon(
        resumo({ estado: 'error', error: NOSSO_ERRO, marketplaceStatus: 'UNSHIPPED' }),
      ),
    ).toBe(true);
    expect(aprovadoAmazon(resumo({ estado: 'aguardandoConfirmacaoDePagamento' }))).toBe(false);
    expect(aprovadoAmazon(resumo({ estado: 'pago' }))).toBe(true);
    expect(aprovadoAmazon(resumo({ estado: 'finalizado' }))).toBe(true);
    expect(aprovadoAmazon(resumo({ estado: null }))).toBe(true);
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
