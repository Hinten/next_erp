import { describe, expect, it } from 'vitest';
import { ESTADO_PEDIDO, type EstadoPedido } from '@delfrance/schemas';

import {
  ALVO_ESTADO_SHOPEE,
  ESTADOS_PEDIDO_SHOPEE_TERMINAL,
  ESTADOS_SHOPEE_GOVERNAVEIS,
  MOTIVO_ESTADO_SHOPEE,
  ORDEM_ESTADO_SHOPEE,
  PREFIXO_ERRO_SHOPEE,
  SHOPEE_ORDER_STATUS,
  estadoPedidoDeOrderStatus,
  estadoShopeeAplicavel,
} from './orderStatusMaps';

/**
 * The estado set `sincronizarEstoquePedido` RESERVES stock for, retyped here on
 * purpose: `apps/functions` is not reachable from `apps/shopee`, and the whole
 * point of the assertion below is that a rung this importer writes lands inside
 * it. If the sync's own set ever changes, the failure has to surface as a
 * disagreement between two files rather than as silence in one.
 */
const ESTADOS_QUE_RESERVAM_ESTOQUE: readonly EstadoPedido[] = [
  ESTADO_PEDIDO.escolhendoFormaDePagamento,
  ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  ESTADO_PEDIDO.emAnalise,
  ESTADO_PEDIDO.emProcessamento,
  ESTADO_PEDIDO.pago,
];

describe('estadoPedidoDeOrderStatus — a escada', () => {
  it.each([
    [SHOPEE_ORDER_STATUS.unpaid, ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento],
    [SHOPEE_ORDER_STATUS.pending, ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento],
    [SHOPEE_ORDER_STATUS.readyToShip, ESTADO_PEDIDO.pago],
    [SHOPEE_ORDER_STATUS.processed, ESTADO_PEDIDO.pago],
    [SHOPEE_ORDER_STATUS.retryShip, ESTADO_PEDIDO.pago],
    [SHOPEE_ORDER_STATUS.shipped, ESTADO_PEDIDO.pago],
    [SHOPEE_ORDER_STATUS.toConfirmReceive, ESTADO_PEDIDO.pago],
    [SHOPEE_ORDER_STATUS.completed, ESTADO_PEDIDO.pago],
    [SHOPEE_ORDER_STATUS.inCancel, ESTADO_PEDIDO.processandoCancelamento],
    [SHOPEE_ORDER_STATUS.cancelled, ESTADO_PEDIDO.cancelado],
  ])('%s → %s', (status, esperado) => {
    expect(estadoPedidoDeOrderStatus(status)).toEqual({
      tipo: ALVO_ESTADO_SHOPEE.estado,
      estado: esperado,
    });
  });

  it('TO_RETURN devolve "manter" — não um estado (decisão do Lucas)', () => {
    expect(estadoPedidoDeOrderStatus(SHOPEE_ORDER_STATUS.toReturn)).toEqual({
      tipo: ALVO_ESTADO_SHOPEE.manter,
    });
  });

  it('cobre os ONZE status documentados — nenhum cai no arm de erro', () => {
    // Anti-vacuity: without this, deleting a `case` above would only fail the
    // row that names it, and a reader could think the table is exhaustive when
    // it stopped being.
    const status = Object.values(SHOPEE_ORDER_STATUS);
    expect(status).toHaveLength(11);
    for (const s of status) {
      expect(estadoPedidoDeOrderStatus(s).tipo).not.toBe(ALVO_ESTADO_SHOPEE.erro);
    }
  });

  it('o REVERSO é enumerado: a escada só produz cinco estados', () => {
    const produzidos = new Set(
      Object.values(SHOPEE_ORDER_STATUS)
        .map(estadoPedidoDeOrderStatus)
        .flatMap((alvo) => (alvo.tipo === ALVO_ESTADO_SHOPEE.estado ? [alvo.estado] : [])),
    );
    expect([...produzidos].sort()).toEqual(
      [
        ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
        ESTADO_PEDIDO.cancelado,
        ESTADO_PEDIDO.pago,
        ESTADO_PEDIDO.processandoCancelamento,
      ].sort(),
    );
    // ⚠️ The five this importer must NEVER write, named rather than implied.
    for (const proibido of [
      ESTADO_PEDIDO.finalizado,
      ESTADO_PEDIDO.fraude,
      ESTADO_PEDIDO.emAnalise,
      ESTADO_PEDIDO.estornadoIntegralmente,
      ESTADO_PEDIDO.pagamentoNaoRealizado,
    ]) {
      expect(produzidos.has(proibido)).toBe(false);
    }
  });

  it('⚠️ UNPAID cai num estado que RESERVA estoque — a troca, fixada', () => {
    const alvo = estadoPedidoDeOrderStatus(SHOPEE_ORDER_STATUS.unpaid);
    expect(alvo.tipo).toBe(ALVO_ESTADO_SHOPEE.estado);
    expect(ESTADOS_QUE_RESERVAM_ESTOQUE).toContain(
      alvo.tipo === ALVO_ESTADO_SHOPEE.estado ? alvo.estado : null,
    );
  });

  it('PENDING fica no MESMO degrau que UNPAID e não avança para emProcessamento', () => {
    expect(estadoPedidoDeOrderStatus(SHOPEE_ORDER_STATUS.pending)).toEqual(
      estadoPedidoDeOrderStatus(SHOPEE_ORDER_STATUS.unpaid),
    );
    expect(estadoPedidoDeOrderStatus(SHOPEE_ORDER_STATUS.pending)).not.toEqual({
      tipo: ALVO_ESTADO_SHOPEE.estado,
      estado: ESTADO_PEDIDO.emProcessamento,
    });
  });

  it('⚠️ ESCOPO: pending_terms NÃO entram na escada — o veredito é o mesmo com e sem', () => {
    // The terms are recorded verbatim on `marketplace.pendingTerms`
    // (`orderMapping.ts`), which is where a reader looks for the reason. The
    // ladder is a function of the STATUS alone, and this pins that a future
    // `ARRANGE_SHIPMENT_PENDING` rung would be a deliberate change here rather
    // than a silent one somewhere else.
    expect(estadoPedidoDeOrderStatus(SHOPEE_ORDER_STATUS.pending)).toEqual({
      tipo: ALVO_ESTADO_SHOPEE.estado,
      estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    });
    expect(estadoPedidoDeOrderStatus('PENDING')).toEqual(
      estadoPedidoDeOrderStatus(SHOPEE_ORDER_STATUS.pending),
    );
  });

  it('COMPLETED continua em pago e NUNCA escreve finalizado', () => {
    expect(estadoPedidoDeOrderStatus(SHOPEE_ORDER_STATUS.completed)).toEqual({
      tipo: ALVO_ESTADO_SHOPEE.estado,
      estado: ESTADO_PEDIDO.pago,
    });
  });

  it('um status desconhecido vira erro com o prefixo [shopee] e o valor entre aspas', () => {
    const alvo = estadoPedidoDeOrderStatus('INVOICE_PENDING');
    expect(alvo).toEqual({
      tipo: ALVO_ESTADO_SHOPEE.erro,
      motivo: '[shopee] status desconhecido: "INVOICE_PENDING"',
    });
    expect(
      alvo.tipo === ALVO_ESTADO_SHOPEE.erro && alvo.motivo.startsWith(PREFIXO_ERRO_SHOPEE),
    ).toBe(true);
  });

  it('⚠️ NEAR-MISS: o casamento é EXATO — minúsculas e espaços não passam', () => {
    // Shopee sends screaming snake case; a tolerant match here would silently
    // absorb a status that is genuinely new (a different value that merely LOOKS
    // like one we know) instead of raising `estado: error`.
    for (const quase of ['ready_to_ship', 'READY_TO_SHIP ', ' READY_TO_SHIP', 'ReadyToShip', '']) {
      expect(estadoPedidoDeOrderStatus(quase).tipo).toBe(ALVO_ESTADO_SHOPEE.erro);
    }
  });
});

describe('estadoShopeeAplicavel — monotonicidade', () => {
  const alvoDe = (estado: EstadoPedido) => ({ tipo: ALVO_ESTADO_SHOPEE.estado, estado }) as const;

  it('aguardandoConfirmacaoDePagamento → pago é aceito', () => {
    expect(
      estadoShopeeAplicavel(
        ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
        alvoDe(ESTADO_PEDIDO.pago),
      ),
    ).toEqual({ escrever: true, estado: ESTADO_PEDIDO.pago, ressuscitado: false });
  });

  it('⚠️ NEAR-MISS: pago → aguardandoConfirmacaoDePagamento é RECUSADO como regressivo', () => {
    // A late `UNPAID` (or a re-reported `PENDING`) must never un-pay a shipped
    // order and re-reserve its stock. The pair above is the same edge in the
    // legal direction.
    expect(
      estadoShopeeAplicavel(
        ESTADO_PEDIDO.pago,
        alvoDe(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento),
      ),
    ).toEqual({ escrever: false, motivo: MOTIVO_ESTADO_SHOPEE.regressivo });
  });

  it('o mesmo estado devolve sem-mudanca (e não escreve)', () => {
    expect(estadoShopeeAplicavel(ESTADO_PEDIDO.pago, alvoDe(ESTADO_PEDIDO.pago))).toEqual({
      escrever: false,
      motivo: MOTIVO_ESTADO_SHOPEE.semMudanca,
    });
  });

  it('alvos FORA da escada ordenada são sempre graváveis', () => {
    for (const destino of [ESTADO_PEDIDO.processandoCancelamento, ESTADO_PEDIDO.cancelado]) {
      expect(estadoShopeeAplicavel(ESTADO_PEDIDO.pago, alvoDe(destino))).toEqual({
        escrever: true,
        estado: destino,
        ressuscitado: false,
      });
    }
  });

  it('processandoCancelamento → pago é aceito — um IN_CANCEL recusado pelo vendedor', () => {
    expect(
      estadoShopeeAplicavel(ESTADO_PEDIDO.processandoCancelamento, alvoDe(ESTADO_PEDIDO.pago)),
    ).toEqual({ escrever: true, estado: ESTADO_PEDIDO.pago, ressuscitado: false });
  });

  it('⚠️ cancelado → pago é ACEITO e marcado como ressuscitado', () => {
    // The live order is the authority (we re-fetch it, we never trust the push
    // body). An absorbing `cancelado` would strand a live sale as cancelled with
    // its stock already released.
    expect(estadoShopeeAplicavel(ESTADO_PEDIDO.cancelado, alvoDe(ESTADO_PEDIDO.pago))).toEqual({
      escrever: true,
      estado: ESTADO_PEDIDO.pago,
      ressuscitado: true,
    });
  });

  it('⚠️ NEAR-MISS: sair de pago para cancelado NÃO é ressuscitar', () => {
    // The flag says "a terminal estado was LEFT", not "a terminal estado was
    // touched" — a `!has(destino)` alone would light up on every cancellation.
    expect(
      estadoShopeeAplicavel(ESTADO_PEDIDO.pago, alvoDe(ESTADO_PEDIDO.cancelado)),
    ).toMatchObject({ escrever: true, ressuscitado: false });
  });

  it('um estado do NEGÓCIO nunca é reescrito — fora-da-escada', () => {
    for (const armazenado of [
      ESTADO_PEDIDO.finalizado,
      ESTADO_PEDIDO.emAnalise,
      ESTADO_PEDIDO.emProcessamento,
      ESTADO_PEDIDO.estornadoIntegralmente,
      ESTADO_PEDIDO.fraude,
      ESTADO_PEDIDO.iniciado,
    ]) {
      expect(estadoShopeeAplicavel(armazenado, alvoDe(ESTADO_PEDIDO.pago))).toEqual({
        escrever: false,
        motivo: MOTIVO_ESTADO_SHOPEE.foraDaEscada,
      });
    }
  });

  it('error ↔ qualquer coisa é gravável nos dois sentidos', () => {
    expect(estadoShopeeAplicavel(ESTADO_PEDIDO.error, alvoDe(ESTADO_PEDIDO.pago))).toMatchObject({
      escrever: true,
      estado: ESTADO_PEDIDO.pago,
    });
    expect(
      estadoShopeeAplicavel(ESTADO_PEDIDO.pago, {
        tipo: ALVO_ESTADO_SHOPEE.erro,
        motivo: '[shopee] status desconhecido: "X"',
      }),
    ).toMatchObject({ escrever: true, estado: ESTADO_PEDIDO.error });
  });

  it('"manter" (TO_RETURN) não escreve estado nenhum, seja qual for o armazenado', () => {
    for (const armazenado of [ESTADO_PEDIDO.pago, ESTADO_PEDIDO.finalizado, ESTADO_PEDIDO.error]) {
      expect(estadoShopeeAplicavel(armazenado, { tipo: ALVO_ESTADO_SHOPEE.manter })).toEqual({
        escrever: false,
        motivo: MOTIVO_ESTADO_SHOPEE.manter,
      });
    }
  });
});

describe('os conjuntos', () => {
  it('ESTADOS_PEDIDO_SHOPEE_TERMINAL é enumerado e contém APENAS cancelado', () => {
    expect([...ESTADOS_PEDIDO_SHOPEE_TERMINAL]).toEqual([ESTADO_PEDIDO.cancelado]);
  });

  it('ESTADOS_SHOPEE_GOVERNAVEIS são exatamente os cinco que esta importação escreve', () => {
    expect([...ESTADOS_SHOPEE_GOVERNAVEIS].sort()).toEqual(
      [
        ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
        ESTADO_PEDIDO.cancelado,
        ESTADO_PEDIDO.error,
        ESTADO_PEDIDO.pago,
        ESTADO_PEDIDO.processandoCancelamento,
      ].sort(),
    );
  });

  it('a escada ORDENADA tem dois degraus, nesta ordem', () => {
    expect([...ORDEM_ESTADO_SHOPEE]).toEqual([
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      ESTADO_PEDIDO.pago,
    ]);
  });
});
