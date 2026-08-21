import { describe, expect, it } from 'vitest';
import {
  PEDIDO_NUMERO_NO_OPERACAO_PREFIX,
  PEDIDO_NUMERO_WIDTH,
  formatPedidoNumero,
  operacaoNumeroPrefix,
} from './createPedido';

describe('operacaoNumeroPrefix', () => {
  it('uppercases the first 3 letters of the operação name', () => {
    expect(operacaoNumeroPrefix('Venda')).toBe('VEN');
    expect(operacaoNumeroPrefix('devolução')).toBe('DEV');
    expect(operacaoNumeroPrefix('  Transferência ')).toBe('TRA');
  });

  it('falls back to NUL when there is no operação name', () => {
    expect(operacaoNumeroPrefix(null)).toBe(PEDIDO_NUMERO_NO_OPERACAO_PREFIX);
    expect(operacaoNumeroPrefix(undefined)).toBe('NUL');
    expect(operacaoNumeroPrefix('   ')).toBe('NUL');
  });

  it('keeps a shorter name as-is (fewer than 3 letters)', () => {
    expect(operacaoNumeroPrefix('Oi')).toBe('OI');
  });
});

describe('formatPedidoNumero', () => {
  it('composes prefix and zero-padded sequence', () => {
    expect(formatPedidoNumero('VEN', 1)).toBe('VEN-000001');
    expect(formatPedidoNumero('NUL', 42)).toBe('NUL-000042');
    expect(formatPedidoNumero('DEV', 1234)).toBe('DEV-001234');
  });

  it('keeps the width for exactly-full and larger values', () => {
    expect(formatPedidoNumero('VEN', 999999)).toBe('VEN-999999');
    // Beyond the width the number is not truncated — it just grows.
    expect(formatPedidoNumero('VEN', 1000000)).toBe('VEN-1000000');
  });

  it('produces lexically sortable strings within a prefix', () => {
    const sorted = [2, 10, 1, 100].map((n) => formatPedidoNumero('VEN', n)).sort();
    expect(sorted).toEqual(['VEN-000001', 'VEN-000002', 'VEN-000010', 'VEN-000100']);
  });

  it('groups by prefix then sequence under a global numero sort', () => {
    // A lexical sort over `numero` groups by operação (alphabetically) and only
    // then orders by sequence within each prefix — it is NOT a single
    // cross-operação sequence order, and NOT a recency order.
    //
    // ⚠️ This is why `numero desc` is no longer the /pedidos default sort
    // (#159 moved it to `timestamp desc`). The behaviour asserted here still
    // governs the Número COLUMN sort, which is what the format guarantees.
    const nums = [
      formatPedidoNumero('VEN', 2),
      formatPedidoNumero('NUL', 10),
      formatPedidoNumero('VEN', 1),
      formatPedidoNumero('DEV', 5),
    ];
    expect([...nums].sort()).toEqual(['DEV-000005', 'NUL-000010', 'VEN-000001', 'VEN-000002']);
  });

  it('exposes the width as a constant', () => {
    expect(PEDIDO_NUMERO_WIDTH).toBe(6);
    // prefix (3) + '-' (1) + padded width
    expect(formatPedidoNumero('VEN', 1)).toHaveLength(3 + 1 + PEDIDO_NUMERO_WIDTH);
  });
});
