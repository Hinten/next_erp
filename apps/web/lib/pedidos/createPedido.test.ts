import { describe, expect, it } from 'vitest';
import { PEDIDO_NUMERO_WIDTH, formatPedidoNumero } from './createPedido';

describe('formatPedidoNumero', () => {
  it('zero-pads to the fixed width', () => {
    expect(formatPedidoNumero(1)).toBe('000001');
    expect(formatPedidoNumero(42)).toBe('000042');
    expect(formatPedidoNumero(1234)).toBe('001234');
  });

  it('keeps the width for exactly-full and larger values', () => {
    expect(formatPedidoNumero(999999)).toBe('999999');
    // Beyond the width the number is not truncated — it just grows.
    expect(formatPedidoNumero(1000000)).toBe('1000000');
  });

  it('produces lexically sortable strings within the width', () => {
    const sorted = [2, 10, 1, 100].map(formatPedidoNumero).sort();
    expect(sorted).toEqual(['000001', '000002', '000010', '000100']);
  });

  it('exposes the width as a constant', () => {
    expect(PEDIDO_NUMERO_WIDTH).toBe(6);
    expect(formatPedidoNumero(1)).toHaveLength(PEDIDO_NUMERO_WIDTH);
  });
});
