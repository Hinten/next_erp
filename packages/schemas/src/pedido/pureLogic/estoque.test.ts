import { describe, expect, it } from 'vitest';
import {
  ESTADOS_FRETE_IGNORAR_REMOCAO,
  ESTADOS_FRETE_REMOVE_ESTOQUE,
  estadoFreteSchema,
} from '../../shared/frete';
import { estadoPedidoSchema } from '../collection/pedido';
import {
  EFEITO_ESTOQUE_NENHUM,
  ESTADOS_PEDIDO_MOVIMENTACAO,
  ESTADOS_PEDIDO_RESERVA,
  efeitoEstoquePedido,
  type EfeitoEstoqueInput,
} from './estoque';

/** Standard sale operação: moves physical stock AND tracks reservations. */
function saidaCompleta(overrides: Partial<EfeitoEstoqueInput> = {}): EfeitoEstoqueInput {
  return {
    estado: 'iniciado',
    estadoFrete: null,
    ehSaida: true,
    movimentaEstoque: true,
    movimentaIndisponivelEstoque: true,
    jaMovimentado: false,
    ...overrides,
  };
}

describe('state sets (legacy parity)', () => {
  it('ESTADOS_PEDIDO_RESERVA mirrors the Dart reservaDeEstoque list', () => {
    expect([...ESTADOS_PEDIDO_RESERVA].sort()).toEqual(
      [
        'escolhendoFormaDePagamento',
        'aguardandoConfirmacaoDePagamento',
        'emAnalise',
        'emProcessamento',
        'pago',
      ].sort(),
    );
  });

  it('ESTADOS_PEDIDO_MOVIMENTACAO mirrors the Dart temMovimentacaoDeEstoque set', () => {
    expect([...ESTADOS_PEDIDO_MOVIMENTACAO].sort()).toEqual(
      [
        'carrinho',
        'escolhendoFormaDePagamento',
        'aguardandoConfirmacaoDePagamento',
        'emAnalise',
        'emProcessamento',
        'pago',
        'estornadoParcialmente',
        'processandoCancelamento',
        'finalizado',
      ].sort(),
    );
  });

  it('every member is a valid estado (guards against enum renames)', () => {
    for (const estado of [...ESTADOS_PEDIDO_RESERVA, ...ESTADOS_PEDIDO_MOVIMENTACAO]) {
      expect(estadoPedidoSchema.safeParse(estado).success).toBe(true);
    }
    for (const estado of [...ESTADOS_FRETE_REMOVE_ESTOQUE, ...ESTADOS_FRETE_IGNORAR_REMOCAO]) {
      expect(estadoFreteSchema.safeParse(estado).success).toBe(true);
    }
  });

  it('reserva states are a subset of movimentação states', () => {
    for (const estado of ESTADOS_PEDIDO_RESERVA) {
      expect(ESTADOS_PEDIDO_MOVIMENTACAO.has(estado)).toBe(true);
    }
  });

  it('frete REMOVE and IGNORAR sets are disjoint (efeitoEstoquePedido relies on it)', () => {
    for (const estado of ESTADOS_FRETE_IGNORAR_REMOCAO) {
      expect(ESTADOS_FRETE_REMOVE_ESTOQUE.has(estado)).toBe(false);
    }
  });
});

describe('efeitoEstoquePedido — saída with reservation (standard sale)', () => {
  it('does nothing before checkout', () => {
    expect(efeitoEstoquePedido(saidaCompleta({ estado: 'iniciado' }))).toEqual(
      EFEITO_ESTOQUE_NENHUM,
    );
    expect(efeitoEstoquePedido(saidaCompleta({ estado: 'carrinho' }))).toEqual(
      EFEITO_ESTOQUE_NENHUM,
    );
  });

  it('reserves through the checkout/payment phase', () => {
    for (const estado of ESTADOS_PEDIDO_RESERVA) {
      expect(efeitoEstoquePedido(saidaCompleta({ estado }))).toEqual({
        reservar: true,
        remover: false,
        adicionar: false,
      });
    }
  });

  it('does NOT remove early when freight is assigned during checkout (legacy quirk fixed)', () => {
    const efeito = efeitoEstoquePedido(
      saidaCompleta({ estado: 'escolhendoFormaDePagamento', estadoFrete: 'iniciado' }),
    );
    expect(efeito).toEqual({ reservar: true, remover: false, adicionar: false });
  });

  it('converts the reservation into a removal when the frete ships', () => {
    for (const estadoFrete of ['empacotado', 'postado', 'entregue'] as const) {
      expect(efeitoEstoquePedido(saidaCompleta({ estado: 'pago', estadoFrete }))).toEqual({
        reservar: false,
        remover: true,
        adicionar: false,
      });
    }
  });

  it('ignores unknown/errored frete estados as removal triggers', () => {
    for (const estadoFrete of ['desconhecido', 'error'] as const) {
      expect(efeitoEstoquePedido(saidaCompleta({ estado: 'pago', estadoFrete }))).toEqual({
        reservar: true,
        remover: false,
        adicionar: false,
      });
    }
  });

  it('removes at finalizado even with no freight (and straight from any state — legacy hole fixed)', () => {
    expect(efeitoEstoquePedido(saidaCompleta({ estado: 'finalizado' }))).toEqual({
      reservar: false,
      remover: true,
      adicionar: false,
    });
  });

  it('holds an applied removal through partial refunds and cancellation processing', () => {
    for (const estado of ['estornadoParcialmente', 'processandoCancelamento', 'pago'] as const) {
      expect(efeitoEstoquePedido(saidaCompleta({ estado, jaMovimentado: true }))).toEqual({
        reservar: false,
        remover: true,
        adicionar: false,
      });
    }
  });

  it('does NOT start a movement in hold-only states (entry vs hold hysteresis)', () => {
    for (const estado of ['estornadoParcialmente', 'processandoCancelamento'] as const) {
      expect(efeitoEstoquePedido(saidaCompleta({ estado, jaMovimentado: false }))).toEqual(
        EFEITO_ESTOQUE_NENHUM,
      );
    }
  });

  it('reverts everything on cancel-like states, even with a shipped frete', () => {
    for (const estado of [
      'cancelado',
      'fraude',
      'error',
      'estornadoIntegralmente',
      'pagamentoNaoRealizado',
      'carrinhoAbandonado',
      'iniciado',
    ] as const) {
      expect(
        efeitoEstoquePedido(
          saidaCompleta({ estado, estadoFrete: 'entregue', jaMovimentado: true }),
        ),
      ).toEqual(EFEITO_ESTOQUE_NENHUM);
    }
  });

  it('releases the reservation while processing a cancellation (not yet removed)', () => {
    expect(efeitoEstoquePedido(saidaCompleta({ estado: 'processandoCancelamento' }))).toEqual(
      EFEITO_ESTOQUE_NENHUM,
    );
  });
});

describe('efeitoEstoquePedido — reservation-less saída (movimentaIndisponivelEstoque=false)', () => {
  const base = { movimentaIndisponivelEstoque: false };

  it('treats sold-as-gone already during the reserva phase (legacy parity)', () => {
    for (const estado of ESTADOS_PEDIDO_RESERVA) {
      expect(efeitoEstoquePedido(saidaCompleta({ ...base, estado }))).toEqual({
        reservar: false,
        remover: true,
        adicionar: false,
      });
    }
  });

  it('never starts at carrinho, reverts on cancellation', () => {
    expect(efeitoEstoquePedido(saidaCompleta({ ...base, estado: 'carrinho' }))).toEqual(
      EFEITO_ESTOQUE_NENHUM,
    );
    expect(
      efeitoEstoquePedido(saidaCompleta({ ...base, estado: 'cancelado', jaMovimentado: true })),
    ).toEqual(EFEITO_ESTOQUE_NENHUM);
  });
});

describe('efeitoEstoquePedido — reserve-only operação (movimentaEstoque=false)', () => {
  const base = { movimentaEstoque: false };

  it('reserves during the reserva phase and never removes', () => {
    expect(efeitoEstoquePedido(saidaCompleta({ ...base, estado: 'pago' }))).toEqual({
      reservar: true,
      remover: false,
      adicionar: false,
    });
    expect(
      efeitoEstoquePedido(saidaCompleta({ ...base, estado: 'pago', estadoFrete: 'entregue' })),
    ).toEqual({ reservar: true, remover: false, adicionar: false });
  });

  it('releases at finalizado (deliberate divergence — legacy leaked these forever)', () => {
    expect(efeitoEstoquePedido(saidaCompleta({ ...base, estado: 'finalizado' }))).toEqual(
      EFEITO_ESTOQUE_NENHUM,
    );
  });
});

describe('efeitoEstoquePedido — entrada (purchase / return)', () => {
  function entrada(overrides: Partial<EfeitoEstoqueInput> = {}): EfeitoEstoqueInput {
    return saidaCompleta({ ehSaida: false, movimentaIndisponivelEstoque: false, ...overrides });
  }

  it('adds stock on the active phases, never reserves', () => {
    for (const estado of ['pago', 'emProcessamento', 'finalizado'] as const) {
      expect(efeitoEstoquePedido(entrada({ estado }))).toEqual({
        reservar: false,
        remover: false,
        adicionar: true,
      });
    }
  });

  it('holds an applied addition while active, reverts on cancellation', () => {
    expect(efeitoEstoquePedido(entrada({ estado: 'carrinho', jaMovimentado: true }))).toEqual({
      reservar: false,
      remover: false,
      adicionar: true,
    });
    expect(efeitoEstoquePedido(entrada({ estado: 'carrinho' }))).toEqual(EFEITO_ESTOQUE_NENHUM);
    expect(efeitoEstoquePedido(entrada({ estado: 'cancelado', jaMovimentado: true }))).toEqual(
      EFEITO_ESTOQUE_NENHUM,
    );
  });

  it('never reserves, even if the operação has the flag set', () => {
    expect(
      efeitoEstoquePedido(entrada({ estado: 'pago', movimentaIndisponivelEstoque: true })),
    ).toEqual({ reservar: false, remover: false, adicionar: true });
  });
});

describe('efeitoEstoquePedido — operação flags off', () => {
  it('does nothing when the operação moves no stock at all', () => {
    expect(
      efeitoEstoquePedido(
        saidaCompleta({
          estado: 'pago',
          movimentaEstoque: false,
          movimentaIndisponivelEstoque: false,
          jaMovimentado: true,
        }),
      ),
    ).toEqual(EFEITO_ESTOQUE_NENHUM);
  });
});
