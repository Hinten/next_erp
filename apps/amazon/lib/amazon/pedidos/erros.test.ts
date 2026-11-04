import { describe, expect, it } from 'vitest';

import {
  AmazonCancelamentoRecenteError,
  AmazonLeituraDefasadaError,
  AmazonPedidoEmConflitoError,
  MOTIVO_PEDIDO_AMAZON_ILEGIVEL,
  PedidoAmazonIlegivelError,
} from './erros';

describe('PedidoAmazonIlegivelError', () => {
  it('carries the 3-7-7 id and a closed code, and nothing else', () => {
    const erro = new PedidoAmazonIlegivelError(
      '171-9876543-2109876',
      MOTIVO_PEDIDO_AMAZON_ILEGIVEL.linhaDuplicada,
    );
    expect(erro).toBeInstanceOf(Error);
    expect(erro.name).toBe('PedidoAmazonIlegivelError');
    expect(erro.orderId).toBe('171-9876543-2109876');
    expect(erro.motivo).toBe('linha-duplicada');
    expect(erro.message).toBe('Pedido da Amazon 171-9876543-2109876 ilegível: linha-duplicada.');
  });

  it('never puts an id outside the grammar into its message', () => {
    const erro = new PedidoAmazonIlegivelError(
      'rua ficticia 100 <x>',
      MOTIVO_PEDIDO_AMAZON_ILEGIVEL.instanteIlegivel,
    );
    expect(erro.orderId).toBeNull();
    expect(erro.message).not.toContain('ficticia');
    expect(erro.message).toContain('<id-invalido>');
  });

  it('5-d adds the `pedido-divergente` code (the answer names another order)', () => {
    expect(MOTIVO_PEDIDO_AMAZON_ILEGIVEL.pedidoDivergente).toBe('pedido-divergente');
  });
});

describe('the importer’s retryable errors (5-d) — ids and counts only, no cause', () => {
  it('AmazonLeituraDefasadaError', () => {
    const erro = new AmazonLeituraDefasadaError('conta-1', '171-9876543-2109876');
    expect(erro).toBeInstanceOf(Error);
    expect(erro.name).toBe('AmazonLeituraDefasadaError');
    expect(erro.contaId).toBe('conta-1');
    expect(erro.orderId).toBe('171-9876543-2109876');
    expect(erro.message).toContain('conta-1/171-9876543-2109876');
    expect(erro.cause).toBeUndefined();
  });

  it('AmazonPedidoEmConflitoError carries the attempt count', () => {
    const erro = new AmazonPedidoEmConflitoError('conta-1', '171-9876543-2109876', 3);
    expect(erro.name).toBe('AmazonPedidoEmConflitoError');
    expect(erro.tentativas).toBe(3);
    expect(erro.message).toContain('3 lotes');
    expect(erro.cause).toBeUndefined();
  });

  it('AmazonCancelamentoRecenteError carries the age in whole seconds', () => {
    const erro = new AmazonCancelamentoRecenteError('conta-1', '171-9876543-2109876', 42);
    expect(erro.name).toBe('AmazonCancelamentoRecenteError');
    expect(erro.idadeS).toBe(42);
    expect(erro.message).toContain('(42 s)');
    expect(erro.cause).toBeUndefined();
  });

  it('never puts an id outside its grammar, or a non-count, into a message', () => {
    const conta = 'conta com espaço';
    const pedido = 'rua ficticia 100';
    for (const erro of [
      new AmazonLeituraDefasadaError(conta, pedido),
      new AmazonPedidoEmConflitoError(conta, pedido, Number.NaN),
      new AmazonCancelamentoRecenteError(conta, pedido, -5),
    ]) {
      expect(erro.message).not.toContain('espaço');
      expect(erro.message).not.toContain('ficticia');
      expect(erro.message).toContain('<conta-invalida>/<id-invalido>');
    }
    expect(new AmazonPedidoEmConflitoError(conta, pedido, Number.NaN).tentativas).toBe(0);
    expect(new AmazonCancelamentoRecenteError(conta, pedido, -5).idadeS).toBe(0);
  });
});
