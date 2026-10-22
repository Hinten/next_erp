import { describe, expect, it } from 'vitest';

import { MOTIVO_PEDIDO_AMAZON_ILEGIVEL, PedidoAmazonIlegivelError } from './erros';

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
});
