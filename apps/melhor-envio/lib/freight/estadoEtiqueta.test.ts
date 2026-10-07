import { describe, expect, it } from 'vitest';
import { efeitoEstoquePedido, ESTADO_FRETE, ESTADO_PEDIDO } from '@delfrance/schemas';

import {
  ehEstadoFreteTerminal,
  meStatusToEstadoFrete,
  resolverEstadoFinalCompraEtiqueta,
} from './estadoEtiqueta';

describe('meStatusToEstadoFrete', () => {
  it('preserves the complete legacy status map', () => {
    expect(meStatusToEstadoFrete('delivered')).toBe('entregue');
    expect(meStatusToEstadoFrete('posted')).toBe('postado');
    expect(meStatusToEstadoFrete('received')).toBe('postado');
    expect(meStatusToEstadoFrete('released')).toBeNull();
    expect(meStatusToEstadoFrete('canceled')).toBe('cancelado');
    expect(meStatusToEstadoFrete('cancelled')).toBe('cancelado');
    expect(meStatusToEstadoFrete('suspended')).toBe('suspenso');
    expect(meStatusToEstadoFrete('paused')).toBe('suspenso');
    expect(meStatusToEstadoFrete('undelivered')).toBe('falhaNaEntrega');
    expect(meStatusToEstadoFrete('created')).toBeNull();
    expect(meStatusToEstadoFrete(null)).toBeNull();
  });
});

describe('ehEstadoFreteTerminal', () => {
  it.each(Object.values(ESTADO_FRETE))('classifies the exact state %s', (estado) => {
    expect(ehEstadoFreteTerminal(estado)).toBe(
      estado === ESTADO_FRETE.entregue || estado === ESTADO_FRETE.cancelado,
    );
  });

  it.each([[null], [undefined], [''], ['delivered'], ['cancelled'], [{}], [[]]])(
    'does not interpret malformed or provider values as terminal: %j',
    (estado) => {
      expect(ehEstadoFreteTerminal(estado)).toBe(false);
    },
  );
});

describe('resolverEstadoFinalCompraEtiqueta', () => {
  it.each([ESTADO_FRETE.entregue, ESTADO_FRETE.cancelado])(
    'preserves terminal %s against every provider status',
    (estado) => {
      for (const status of [
        'posted',
        'received',
        'delivered',
        'canceled',
        'suspended',
        'undelivered',
        'released',
        'unknown',
        null,
        undefined,
      ]) {
        expect(resolverEstadoFinalCompraEtiqueta(estado, status)).toBe(estado);
      }
    },
  );

  it.each(['released', 'created', 'unknown', null, undefined])(
    'never moves postado backwards for provider status %s',
    (status) => {
      expect(resolverEstadoFinalCompraEtiqueta(ESTADO_FRETE.postado, status)).toBe(
        ESTADO_FRETE.postado,
      );
    },
  );

  it.each([
    ['posted', ESTADO_FRETE.postado],
    ['received', ESTADO_FRETE.postado],
    ['delivered', ESTADO_FRETE.entregue],
    ['canceled', ESTADO_FRETE.cancelado],
    ['cancelled', ESTADO_FRETE.cancelado],
    ['suspended', ESTADO_FRETE.suspenso],
    ['paused', ESTADO_FRETE.suspenso],
    ['undelivered', ESTADO_FRETE.falhaNaEntrega],
  ])('still applies the provider transition %s', (status, esperado) => {
    expect(resolverEstadoFinalCompraEtiqueta(ESTADO_FRETE.postado, status)).toBe(esperado);
    expect(resolverEstadoFinalCompraEtiqueta(ESTADO_FRETE.aguardandoPostagem, status)).toBe(
      esperado,
    );
  });

  it.each([[null], [undefined], [{}], [[]], [42], ['legacy-unknown']])(
    'tolerates malformed stored state %j',
    (estado) => {
      expect(resolverEstadoFinalCompraEtiqueta(estado, 'released')).toBe(
        ESTADO_FRETE.aguardandoPostagem,
      );
      expect(resolverEstadoFinalCompraEtiqueta(estado, 'posted')).toBe(ESTADO_FRETE.postado);
    },
  );

  it('does not normalize provider status casing or whitespace', () => {
    expect(meStatusToEstadoFrete('POSTED')).toBeNull();
    expect(meStatusToEstadoFrete(' posted ')).toBeNull();
    expect(meStatusToEstadoFrete(undefined)).toBeNull();
  });
});

describe('fresh-anchor normalization and stock', () => {
  it.each([false, true])(
    'has the same stock effect before and after normalization (already moved: %s)',
    (jaMovimentado) => {
      const input = {
        estado: ESTADO_PEDIDO.pago,
        ehSaida: true,
        movimentaEstoque: true,
        movimentaIndisponivelEstoque: true,
        jaMovimentado,
      };
      expect(
        efeitoEstoquePedido({ ...input, estadoFrete: ESTADO_FRETE.aguardandoPostagem }),
      ).toEqual(efeitoEstoquePedido({ ...input, estadoFrete: ESTADO_FRETE.postado }));
    },
  );
});
